/**
 * Convert standard Markdown (the dialect LLMs emit by default) into the
 * Slack `mrkdwn` dialect used by `chat.postMessage` and section blocks.
 *
 * Slack mrkdwn differences:
 *   - bold uses `*text*` (not `**text**`)
 *   - italic uses `_text_` (not `*text*`)
 *   - strikethrough uses `~text~` (not `~~text~~`)
 *   - headings are not supported — render as bold
 *   - bullets render as `• ` (not `*` or `-`)
 *   - links use `<url|label>` (not `[label](url)`)
 *
 * Fenced code blocks (``` ... ```) and inline code (`...`) are passed through
 * untouched so log excerpts and JSON payloads stay verbatim.
 */
export function toSlackMrkdwn(input: string): string {
  if (!input) return input;
  // Split on fenced code blocks; transform only the non-code segments.
  const parts = input.split(/(```[\s\S]*?```)/g);
  return parts
    .map((part) => (part.startsWith("```") ? part : transformSegment(part)))
    .join("");
}

function transformSegment(seg: string): string {
  // Process line by line so headings/bullets only match line starts.
  const lines = seg.split("\n").map(transformLine);
  return lines.join("\n");
}

function transformLine(line: string): string {
  // Walk inline-code spans so we don't rewrite their contents.
  const tokens = line.split(/(`[^`]*`)/g);
  return tokens
    .map((tok, i) => (i % 2 === 1 ? tok : transformInline(tok)))
    .join("")
    .replace(/^(\s*)#{1,6}\s+(.*)$/, "$1*$2*") // heading -> bold
    .replace(/^(\s*)[-*+]\s+/, "$1• "); // bullet -> Slack bullet
}

// Sentinels: any chars never produced by the converter or expected in input.
const BOLD_OPEN = "";
const BOLD_CLOSE = "";

function transformInline(s: string): string {
  let out = s;
  // Links: [label](url) -> <url|label>. Skip image syntax (![alt](url)).
  out = out.replace(/(^|[^!])\[([^\]]+)\]\(([^)\s]+)\)/g, "$1<$3|$2>");
  // Bold: stash with sentinels so italic pass below doesn't re-convert them.
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
  out = out.replace(/__([^_\n]+?)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);
  // Strikethrough: ~~x~~ -> ~x~
  out = out.replace(/~~([^~\n]+?)~~/g, "~$1~");
  // Italic: any remaining *x* — single-asterisk italic — becomes _x_.
  // Bounded by non-space inside and word-edge outside.
  out = out.replace(/(^|[\s(])\*(\S[^*\n]*?\S|\S)\*(?=[\s).,!?;:]|$)/g, "$1_$2_");
  // Restore sentinels as Slack bold.
  out = out.split(BOLD_OPEN).join("*").split(BOLD_CLOSE).join("*");
  return out;
}
