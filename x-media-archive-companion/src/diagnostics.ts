export const DIAGNOSTIC_LOG_MAX_BYTES = 256 * 1024;

interface DiagnosticAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface DiagnosticEntry {
  event: string;
  details?: Record<string, unknown>;
}

// `failures` is the raw error list and stays out of the log; `failureCount` and
// `failureCategories` are derived, already-sanitised values and are the only
// record of why an import fell short, so they must survive.
const SENSITIVE_KEY = /token|cookie|authorization|secret|password|path|message|^failures$/i;

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[depth-limited]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.replace(/[\r\n\t]+/g, " ").slice(0, 256);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      if (!SENSITIVE_KEY.test(key)) result[key] = safeValue(item, depth + 1);
    }
    return result;
  }
  return typeof value;
}

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  const marker = Buffer.from('{"event":"log-truncated"}\n', "utf8");
  const tail = bytes.subarray(bytes.length - (maxBytes - marker.length)).toString("utf8").replace(/^\uFFFD+/, "");
  return marker.toString("utf8") + tail.slice(tail.indexOf("\n") + 1);
}

export function safeUriDiagnostic(parameters: Record<string, unknown>): Record<string, unknown> {
  const action = parameters.action;
  const job = parameters.job;
  const vault = parameters.vault;
  return {
    actionMatches: action === "x-media-archive-import",
    actionType: typeof action,
    job: typeof job === "string" && /^[0-9a-f-]{36}$/i.test(job) ? job : null,
    jobType: typeof job,
    vaultType: typeof vault,
    unknownKeyCount: Object.keys(parameters).filter((key) => !["action", "job", "vault"].includes(key)).length,
  };
}

export function safeErrorDiagnostic(error: unknown): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code.slice(0, 32) : null;
  const text = `${code ?? ""} ${value.message}`;
  let category = "unexpected-error";
  // The two ways media goes missing. Keeping them apart here is the whole
  // reason the log is worth reading: one is the extension failing to fetch
  // from X, the other is this plugin losing a file it was handed.
  if (/download-failed/.test(text)) category = "media-download-failed";
  else if (/import-lost/.test(text)) category = "media-import-lost";
  else if (/ENOSPC/i.test(text)) category = "disk-full";
  else if (/EACCES|EPERM/i.test(text)) category = "permission-denied";
  else if (/local filesystem vault/i.test(text)) category = "adapter-not-local";
  else if (/invalid local vault path/i.test(text)) category = "adapter-path-invalid";
  else if (/no completed manifest/i.test(text)) category = "manifest-missing";
  else if (/manifest|schema|chunk|marker/i.test(text)) category = "manifest-invalid";
  else if (/job folder and completed job ID differ/i.test(text)) category = "job-id-mismatch";
  else if (/unsafe|escapes its root|traversal/i.test(text)) category = "unsafe-path";
  else if (/collision|already exists/i.test(text)) category = "destination-collision";
  return { name: value.name.slice(0, 64), code, category };
}

export class DiagnosticLog {
  readonly relativePath: string;
  private queue: Promise<void> = Promise.resolve();
  private readonly adapter: DiagnosticAdapter;
  private directoryEnsured = false;

  constructor(adapter: DiagnosticAdapter, manifestDirectory: string | undefined) {
    this.adapter = adapter;
    const directory = (manifestDirectory ?? ".obsidian/plugins/x-media-archive-companion").replace(/\\/g, "/").replace(/\/+$/, "");
    this.relativePath = `${directory}/diagnostic.log`;
  }

  log(entry: DiagnosticEntry): Promise<void> {
    this.queue = this.queue.then(async () => {
      const safeEntry = safeValue(entry) as DiagnosticEntry;
      const line = JSON.stringify({ at: new Date().toISOString(), ...safeEntry }) + "\n";
      let previous = "";
      if (!this.directoryEnsured) {
        const directory = this.relativePath.slice(0, this.relativePath.lastIndexOf("/"));
        const segments = directory.split("/").filter(Boolean);
        let current = "";
        for (const segment of segments) {
          current = current ? `${current}/${segment}` : segment;
          // exists() answers from Obsidian's vault index, which never learns
          // about directories the importer creates through node fs. A false
          // negative makes mkdir throw "already exists" for a directory that is
          // physically present, so neither result may abort the log write --
          // only the write itself decides whether this path is usable.
          try { if (!await this.adapter.exists(current)) await this.adapter.mkdir(current); }
          catch { /* directory already present, or creation is not permitted */ }
        }
        this.directoryEnsured = true;
      }
      try { if (await this.adapter.exists(this.relativePath)) previous = await this.adapter.read(this.relativePath); }
      catch { previous = ""; }
      await this.adapter.write(this.relativePath, boundedUtf8(previous + line, DIAGNOSTIC_LOG_MAX_BYTES));
    }).catch((error) => { console.error("[XMediaArchive] diagnostic log write failed", safeErrorDiagnostic(error)); });
    return this.queue;
  }
}
