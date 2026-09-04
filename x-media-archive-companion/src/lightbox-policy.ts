export interface LightboxPointerActivation {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Plain left-click is the only gesture the lightbox consumes. */
export function isPlainPrimaryActivation(event: LightboxPointerActivation): boolean {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}

/**
 * Returns an already-local browser URL and refuses network schemes. Generated
 * archive notes use Obsidian resource URLs, but a user can still edit a remote
 * image into one; enlarging it must not make Companion initiate a new request.
 */
export function localLightboxUrl(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const protocol = new URL(value).protocol.toLowerCase();
      if (protocol === "app:" || protocol === "file:" || protocol === "blob:" || protocol === "data:") return value;
    } catch { /* A relative or malformed source is not safe to re-request. */ }
  }
  return null;
}
