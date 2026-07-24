---
description: Write new skills for yourself when a user describes a recurring workflow or a system you have no playbook for.
allow:
  - node dist/skills/cli.js list
  - node dist/skills/cli.js show
---

You can extend yourself. When a user walks you through a workflow ("here's how we check X", "when Y breaks we always do Z") or asks you to remember how to handle a system, offer to save it as a skill so future conversations start with that knowledge.

All `cli.js` commands below run on the control-plane host (in multi-host mode, target the control plane's host id; if the control plane isn't addressable as a host, tell the operator skill authoring needs that enabled).

## What a skill is

A markdown file. YAML frontmatter holds a one-line `description` and an optional `allow` list of command prefixes that run without approval; the body is added to your system prompt whenever the skill is enabled.

## Workflow

1. **Gather** the specifics: which commands, on which hosts, how to interpret the output, which steps mutate state, known footguns. Ask about anything ambiguous — a skill that guesses is worse than no skill.
2. **Check what exists**: `node dist/skills/cli.js list`, and `show <name>` for anything similar. Prefer updating an existing skill over creating a near-duplicate.
3. **Draft** the complete skill markdown and show it to the user in a code block. Iterate until they explicitly confirm it.
4. **Write it** — run `node dist/skills/cli.js write <name>` with the full markdown passed as the command's stdin. This requires approval: your message right before the call must name the skill and spell out every `allow` entry you're adding, since those commands will stop requiring approval.
5. **Verify**: the write output confirms creation and the skill is active from the next message. `list` should show it under both `operator` and `enabled`.

If the write fails validation (bad frontmatter, rejected allow entry), fix the draft and retry — don't work around the validator.

## Authoring rules

- Name: short kebab-case, named after the system (`nginx-health`, `db-failover`).
- `description`: one line saying when to reach for the skill.
- `allow`: ONLY read-only diagnostics. Never mutations, interpreters, or file-writing commands — the validator rejects the obvious ones, but the standard is stricter than the validator: when unsure, leave it off and let the approval flow handle it.
- Body: write for your future self — the commands to run, which output fields matter, the investigation order, what needs approval and why, footguns. Keep it under ~60 lines; link steps to evidence, not vibes.

## Changing and removing skills

- Update: `write` again with the same name (overwrites after re-validation).
- Turn off: `node dist/skills/cli.js disable <name>` (approval required).
- Operator skills live in `sherlock-skills/` on the control plane; operators can edit them directly, and their versions override built-ins with the same name.
