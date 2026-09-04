export interface PropertyRow { key: string; text: string; href: string | null; }
export interface PropertyDocument { path: string; title: string; kind: "post" | "profile"; rows: PropertyRow[]; }

function normalizePath(value: string): string { return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""); }

export function isXmcPropertyNote(path: string | null | undefined, vaultRoot: string, frontmatter: unknown): boolean {
  if (!path || !frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return false;
  const file = normalizePath(path); const root = normalizePath(vaultRoot);
  if (!root || !file.startsWith(`${root}/`)) return false;
  const values = frontmatter as Record<string, unknown>;
  return file.endsWith("/_profile.md") || values.tweet_id !== undefined;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

export function propertyDocument(path: string, vaultRoot: string, frontmatter: unknown): PropertyDocument | null {
  if (!isXmcPropertyNote(path, vaultRoot, frontmatter)) return null;
  const values = frontmatter as Record<string, unknown>;
  const rows = Object.entries(values)
    .filter(([key]) => key !== "position")
    .map(([key, value]) => {
      const text = displayValue(value);
      return { key, text, href: /^https?:\/\/\S+$/i.test(text) ? text : null };
    });
  const name = normalizePath(path).split("/").pop()?.replace(/\.md$/i, "") ?? path;
  return { path, title: name, kind: normalizePath(path).endsWith("/_profile.md") ? "profile" : "post", rows };
}
