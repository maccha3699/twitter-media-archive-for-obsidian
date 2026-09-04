import { isUuidV4 } from "./validation.ts";

/** Only `job` is application input; Obsidian's reserved `action`/`vault` parameters are ignored. */
export function uriJobId(parameters: Record<string, unknown>): string | null {
  if (Object.keys(parameters).some((key) => key !== "action" && key !== "job" && key !== "vault")) return null;
  if (parameters.action !== undefined && parameters.action !== "x-media-archive-import") return null;
  if (parameters.vault !== undefined && typeof parameters.vault !== "string") return null;
  return typeof parameters.job === "string" && isUuidV4(parameters.job) ? parameters.job : null;
}
