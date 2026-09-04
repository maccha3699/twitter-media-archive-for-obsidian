interface LocalVaultAdapter {
  getBasePath(): unknown;
}

/**
 * Obsidian may expose its adapter across an Electron realm boundary, where
 * `instanceof FileSystemAdapter` is not reliable. The desktop contract we need
 * is the narrower getBasePath capability.
 */
export function localVaultBasePath(adapter: unknown): string {
  if (!adapter || typeof adapter !== "object" || typeof (adapter as Partial<LocalVaultAdapter>).getBasePath !== "function") {
    throw new Error("This plugin requires Obsidian desktop with a local filesystem vault.");
  }
  const result = (adapter as LocalVaultAdapter).getBasePath();
  if (typeof result !== "string" || result.trim() === "") {
    throw new Error("Obsidian returned an invalid local vault path.");
  }
  return result;
}
