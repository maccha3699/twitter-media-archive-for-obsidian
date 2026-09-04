export const OWNERSHIP_MARKER = "<!--xmc:user-->";
const MARKER = OWNERSHIP_MARKER;

export class MarkdownOwnershipError extends Error {
  constructor(message: string) { super(message); this.name = "MarkdownOwnershipError"; }
}

type Block = { key: string | null; raw: string };

function splitFrontmatter(markdown: string): { before: string; blocks: Block[]; after: string } {
  const opening = markdown.match(/^---(?:\r\n|\n)/);
  if (!opening) throw new MarkdownOwnershipError("markdown frontmatter is missing");
  const start = opening[0].length;
  const close = markdown.slice(start).match(/^---(?:\r\n|\n|$)/m);
  if (!close || close.index === undefined) throw new MarkdownOwnershipError("markdown frontmatter is unterminated");
  const body = markdown.slice(start, start + close.index);
  const after = markdown.slice(start + close.index + close[0].length);
  const lines = body.match(/.*(?:\r\n|\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const line of lines) {
    const key = /^(?![ \t])((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^:\r\n]+)):(?:[ \t]|\r?\n|$)/.exec(line)?.[1] ?? null;
    if (key !== null) {
      if (current) blocks.push(current);
      current = { key, raw: line };
    } else if (/^[ \t]*(?:#|\r?\n|$)/.test(line) || /^[ \t]/.test(line)) {
      if (!current) current = { key: null, raw: line };
      else current.raw += line;
    } else {
      throw new MarkdownOwnershipError(`frontmatter has an unsafe top-level line: ${JSON.stringify(line)}`);
    }
  }
  if (current) blocks.push(current);
  return { before: markdown.slice(0, start), blocks, after };
}

export function mergeManagedFrontmatter(previous: string | null, generated: string, managed: ReadonlySet<string> | ((key: string) => boolean)): string {
  if (!previous) return generated;
  const oldParts = splitFrontmatter(previous);
  const newParts = splitFrontmatter(generated);
  const isManaged = typeof managed === "function" ? managed : (key: string) => managed.has(key);
  const merged: Block[] = [];
  const oldByKey = new Map<string, Block>();
  for (const block of oldParts.blocks) if (block.key !== null) oldByKey.set(block.key, block);
  for (const block of newParts.blocks) {
    if (block.key === null || isManaged(block.key)) merged.push(block);
    else merged.push(oldByKey.get(block.key) ?? block);
  }
  const generatedKeys = new Set(newParts.blocks.flatMap((block) => block.key ? [block.key] : []));
  for (const block of oldParts.blocks) {
    if (block.key !== null && !generatedKeys.has(block.key) && !isManaged(block.key)) merged.push(block);
  }
  const frontmatter = merged.map((block) => block.raw).join("");
  const opening = newParts.before;
  const ending = generated.slice(generated.indexOf("---", newParts.before.length));
  const closeMatch = ending.match(/^---(?:\r\n|\n|$)/);
  if (!closeMatch) throw new MarkdownOwnershipError("generated frontmatter is malformed");
  return `${opening}${frontmatter}${closeMatch[0]}${newParts.after}`;
}

export function ownershipTail(previous: string | null): string {
  if (!previous) return "";
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const index = previous.indexOf(MARKER, from);
    if (index < 0) break;
    positions.push(index); from = index + MARKER.length;
  }
  if (positions.length !== 1) throw new MarkdownOwnershipError("existing note must contain exactly one ownership marker");
  const index = positions[0];
  if (index > 0 && previous[index - 1] !== "\n") throw new MarkdownOwnershipError("ownership marker must start at column zero");
  const ending = previous.slice(index + MARKER.length);
  let length = 0;
  if (ending.startsWith("\r\n")) length = 2;
  else if (ending.startsWith("\n")) length = 1;
  else if (ending.length !== 0) throw new MarkdownOwnershipError("ownership marker line ending is invalid");
  return previous.slice(index + MARKER.length + length);
}

export function renderOwnedMarkdown(generated: string, previous: string | null): string {
  const tail = ownershipTail(previous);
  const merged = previous ? mergeManagedFrontmatter(previous, generated, (key) => POST_MANAGED_KEYS.has(key) || key.startsWith("xmc_thread_")) : generated;
  const bodyStart = merged.match(/^---(?:\r\n|\n)[\s\S]*?^---(?:\r\n|\n|$)/m)?.[0].length;
  if (bodyStart === undefined) throw new MarkdownOwnershipError("generated markdown frontmatter is malformed");
  const body = merged.slice(bodyStart).replace(/\r\n/g, "\n").replace(/\n*$/, "");
  return `${merged.slice(0, bodyStart)}${body}\n${MARKER}\n${tail}`;
}

export const POST_MANAGED_KEYS = new Set([
  "schemaVersion", "created_at", "archived_at", "archive_job_id", "archive_state", "metadata_status",
  "tweet_id", "tweet_url", "author_id", "author_screen_name", "author_display_name",
  "xmc_pinned", "xmc_favorite",
]);

export function markerLine(): string { return `${MARKER}\n`; }
