import { z } from "zod";
import type { HostResolver } from "../executor/hostResolver.js";
import { defineTool, type Tool, type ToolScope } from "./types.js";
import { isAllowlisted, tokenize } from "./shell.js";

/* ─── YAML schema (operator-facing) ───────────────────────────────────── */

const fieldTypeSchema = z.enum([
  "string",
  "number",
  "integer",
  "boolean",
  "host_enum",
  "enum",
]);

const fieldSchema = z.object({
  type: fieldTypeSchema,
  description: z.string().optional(),
  optional: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Required when type === 'enum'. */
  values: z.array(z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const declarationSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/i, "tool name must be a simple identifier"),
  description: z.string().min(1),
  scope: z.enum(["read", "mutate", "dangerous"]),
  schema: z.record(fieldSchema).optional().default({}),
  exec: z.object({
    argv: z.array(z.string()).min(1, "exec.argv must have at least one element"),
  }),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  allowlistDowngrade: z.boolean().optional().default(false),
}).strict();

const fileSchema = z.object({
  tools: z.array(declarationSchema).default([]),
}).strict();

export type ToolDeclaration = z.infer<typeof declarationSchema>;
export type ToolsFile = z.infer<typeof fileSchema>;

/** Parses a raw YAML/JSON-shaped object into a validated ToolsFile. */
export function parseToolsFile(raw: unknown): ToolsFile {
  return fileSchema.parse(raw ?? { tools: [] });
}

/* ─── Conversion ──────────────────────────────────────────────────────── */

const TEMPLATE_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Build the in-memory Tool[] from declarations. Performs cross-field
 * validation (template refs must exist, enums must declare values, etc.).
 */
export function buildDeclarativeTools(
  decls: ToolDeclaration[],
  resolver: HostResolver,
): Tool[] {
  return decls.map((d) => buildOne(d, resolver));
}

function buildOne(d: ToolDeclaration, resolver: HostResolver): Tool {
  const fields = d.schema;
  const fieldNames = new Set(Object.keys(fields));

  // Cross-validate: every {{var}} in argv must reference a declared field.
  for (const part of d.exec.argv) {
    for (const match of part.matchAll(TEMPLATE_RE)) {
      const ref = match[1]!;
      if (!fieldNames.has(ref) && ref !== "host") {
        throw new Error(
          `tool '${d.name}': argv template references undeclared field '${ref}'`,
        );
      }
    }
  }

  // 'enum' fields must declare values.
  for (const [fname, f] of Object.entries(fields)) {
    if (f.type === "enum" && (!f.values || f.values.length === 0)) {
      throw new Error(`tool '${d.name}': field '${fname}' is enum but has no values`);
    }
  }

  // Build the user-arg portion of the zod schema.
  const userShape: Record<string, z.ZodTypeAny> = {};
  for (const [fname, f] of Object.entries(fields)) {
    userShape[fname] = zodForField(d.name, fname, f);
  }

  // Add an implicit `host` field — required in multi-host mode.
  const known = resolver.knownHosts();
  const multi = resolver.isMultiHost();
  if (multi) {
    userShape.host = z
      .enum(known as [string, ...string[]])
      .describe(`Target host. One of: ${known.join(", ")}`);
  } else {
    userShape.host = z
      .string()
      .optional()
      .describe("Host (ignored in single-host mode)");
  }

  const schema = z.object(userShape).strict();

  return defineTool({
    name: d.name,
    description: d.description,
    scope: d.scope,
    schema,
    evaluateScope: (args): ToolScope => {
      if (!d.allowlistDowngrade) return d.scope;
      const { argv } = resolveArgv(d.exec.argv, args as Record<string, unknown>);
      const a = args as { host?: string };
      const allowlist = resolver.shellAllowlistFor(a.host);
      return isAllowlisted(argv, allowlist) ? "read" : d.scope;
    },
    run: async (args) => {
      const a = args as Record<string, unknown> & { host?: string };
      const { argv } = resolveArgv(d.exec.argv, a);
      const [bin, ...rest] = argv;
      if (!bin) throw new Error(`tool '${d.name}': empty argv after substitution`);
      const r = await resolver.resolve(a.host).exec({
        command: bin,
        args: rest,
        timeoutMs: d.timeoutMs,
      });
      return {
        argv,
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        durationMs: r.durationMs,
        truncated: r.truncated,
      };
    },
  });
}

function zodForField(
  toolName: string,
  fieldName: string,
  f: ToolDeclaration["schema"][string],
): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (f.type) {
    case "string":
      base = z.string();
      break;
    case "number":
      base = applyNumberBounds(z.number(), f);
      break;
    case "integer":
      base = applyNumberBounds(z.number().int(), f);
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "host_enum":
      // Author intent unclear when host_enum used on a non-host field; treat as string.
      base = z.string();
      break;
    case "enum":
      base = z.enum(f.values as [string, ...string[]]);
      break;
    default: {
      const _exhaustive: never = f.type;
      throw new Error(
        `tool '${toolName}': field '${fieldName}' has unknown type ${String(_exhaustive)}`,
      );
    }
  }
  if (f.description) base = base.describe(f.description);
  if (f.optional) {
    base = f.default !== undefined ? base.default(f.default) : base.optional();
  } else if (f.default !== undefined) {
    base = base.default(f.default);
  }
  return base;
}

function applyNumberBounds(
  base: z.ZodNumber,
  f: ToolDeclaration["schema"][string],
): z.ZodNumber {
  let out = base;
  if (typeof f.min === "number") out = out.min(f.min);
  if (typeof f.max === "number") out = out.max(f.max);
  return out;
}

/**
 * Substitute `{{var}}` placeholders into argv. An argv element is dropped
 * entirely when any of its placeholders resolves to undefined/null — this
 * makes optional flags work naturally:
 *
 *   ["pg_dump", "--table={{table}}"]
 *     with table=users  -> ["pg_dump", "--table=users"]
 *     with table unset  -> ["pg_dump"]
 *
 * Literal elements without placeholders (e.g. "--quiet") always pass through.
 */
export function resolveArgv(
  template: string[],
  args: Record<string, unknown>,
): { argv: string[] } {
  const out: string[] = [];
  for (const part of template) {
    let missing = false;
    const resolved = part.replace(TEMPLATE_RE, (_match, ref: string) => {
      const v = args[ref];
      if (v === undefined || v === null) {
        missing = true;
        return "";
      }
      return String(v);
    });
    if (missing) continue;
    out.push(resolved);
  }
  // Re-export tokenize purely so the allowlist matcher (which operates on
  // tokenized argv) sees the same shape; here argv is already array-shaped.
  void tokenize;
  return { argv: out };
}
