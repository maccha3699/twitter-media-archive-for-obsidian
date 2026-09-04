import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";

export const COMPONENT_BUDGET = 200;
export const ABSOLUTE_PATH_BUDGET = 240;
export const WINDOWS_RESERVED_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
export const RESERVED_AUTHOR_FOLDERS = new Set(["_accounts", "_media", "_system", "_index", "_profile"]);

export function caseFold(value: string): string { return value.toLocaleLowerCase("en-US"); }
export function pathHash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 12); }
export function unsafeSegment(value: string): boolean {
  return !value || /[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[ .]$/.test(value) || WINDOWS_RESERVED_NAMES.test(value);
}
export function safeSegment(value: string, fallback = "unknown"): string {
  const cleaned = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/[ .]+$/g, "").trim() || fallback;
  if (WINDOWS_RESERVED_NAMES.test(cleaned)) return `${cleaned}-${pathHash(value)}`;
  return cleaned;
}
export function shortenSegment(value: string, identity: string, budget = COMPONENT_BUDGET): string {
  if (value.length <= budget && !unsafeSegment(value)) return value;
  const suffix = pathHash(identity);
  const head = Math.max(1, budget - suffix.length - 1);
  return `${safeSegment(value.slice(0, head), "item")}-${suffix}`;
}
export function tempBasename(kind: string, uuid: string = randomUUID()): string {
  return `.xmc-${kind}-${uuid}`;
}
export function validateTempTarget(vaultBase: string, target: string, kind: string, uuid: string): void {
  const resolved = path.resolve(vaultBase, target);
  const relative = path.relative(path.resolve(vaultBase), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe path target");
  if (resolved.length > ABSOLUTE_PATH_BUDGET) throw new Error("path exceeds 240 UTF-16 code units");
  for (const component of relative.split(path.sep)) if (component.length > COMPONENT_BUDGET) throw new Error("path component exceeds 200 UTF-16 code units");
  const temp = path.join(path.dirname(resolved), tempBasename(kind, uuid));
  if (temp.length > ABSOLUTE_PATH_BUDGET || path.basename(temp).length > COMPONENT_BUDGET) throw new Error("temporary path exceeds safety budget");
}

export function validateAbsoluteTarget(target: string, kind: string, uuid: string): void {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean);
  if (resolved.length > ABSOLUTE_PATH_BUDGET || components.some((component) => component.length > COMPONENT_BUDGET)) throw new Error("path exceeds safety budget");
  const temp = path.join(path.dirname(resolved), tempBasename(kind, uuid));
  const tempComponents = temp.slice(path.parse(temp).root.length).split(path.sep).filter(Boolean);
  if (temp.length > ABSOLUTE_PATH_BUDGET || tempComponents.some((component) => component.length > COMPONENT_BUDGET)) throw new Error("temporary path exceeds safety budget");
}
