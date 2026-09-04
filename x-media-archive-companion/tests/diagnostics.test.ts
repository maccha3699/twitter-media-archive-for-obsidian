import assert from "node:assert/strict";
import test from "node:test";
import { DIAGNOSTIC_LOG_MAX_BYTES, DiagnosticLog, safeErrorDiagnostic, safeUriDiagnostic } from "../src/diagnostics.ts";

class MemoryAdapter {
  files = new Map<string, string>();
  directories = new Set<string>();
  async exists(path: string): Promise<boolean> { return this.files.has(path) || this.directories.has(path); }
  async read(path: string): Promise<string> { return this.files.get(path) ?? ""; }
  async write(path: string, data: string): Promise<void> { this.files.set(path, data); }
  async mkdir(path: string): Promise<void> { this.directories.add(path); }
}

test("diagnostic log creates its archive system directory, serializes, and stays size bounded", async () => {
  const adapter = new MemoryAdapter();
  const log = new DiagnosticLog(adapter, "XMediaArchive/_system");
  await Promise.all(Array.from({ length: 400 }, (_, index) => log.log({ event: "phase", details: { index, padding: "x".repeat(1000) } })));
  const output = adapter.files.get(log.relativePath) ?? "";
  assert.equal(log.relativePath, "XMediaArchive/_system/diagnostic.log");
  assert.deepEqual([...adapter.directories], ["XMediaArchive", "XMediaArchive/_system"]);
  assert.ok(Buffer.byteLength(output, "utf8") <= DIAGNOSTIC_LOG_MAX_BYTES);
  assert.match(output, /"index":399/);
  for (const line of output.trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
});

test("derived failure counts survive the log while raw failure text does not", async () => {
  const adapter = new MemoryAdapter();
  const log = new DiagnosticLog(adapter, "XMediaArchive/_system");
  await log.log({ event: "import-outcome", details: {
    state: "partial", retryable: false, failureCount: 3,
    failureCategories: ["unexpected-error"],
    failures: ["1830000000000000000: 3_abc C:/Users/private/staging is gone"],
  } });
  const output = adapter.files.get(log.relativePath) ?? "";
  assert.match(output, /"failureCount":3/, "the log must say how much was lost");
  assert.match(output, /"failureCategories":\["unexpected-error"\]/, "and in what way");
  assert.doesNotMatch(output, /private|staging/, "raw failure text still carries paths and stays out");
});

test("URI diagnostics retain only safe reserved values and an unknown-key count", () => {
  assert.deepEqual(safeUriDiagnostic({ action: "x-media-archive-import", job: "123e4567-e89b-42d3-a456-426614174000", vault: "private-vault", path: "C:/secret", token: "secret" }), {
    actionMatches: true,
    actionType: "string",
    job: "123e4567-e89b-42d3-a456-426614174000",
    jobType: "string",
    vaultType: "string",
    unknownKeyCount: 2,
  });
});

test("errors are classified without retaining messages, paths, or credentials", () => {
  const diagnostic = safeErrorDiagnostic(Object.assign(new Error("EACCES C:/Users/private token=secret"), { code: "EACCES" }));
  assert.deepEqual(diagnostic, { name: "Error", code: "EACCES", category: "permission-denied" });
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|secret|token/i);
  // The point of the split: the log says which side lost the file.
  assert.equal(safeErrorDiagnostic(new Error("3_abc: download-failed — Xからの取得に失敗 (downloadState=missing)")).category, "media-download-failed");
  assert.equal(safeErrorDiagnostic(new Error("3_abc: import-lost — 取得済みだが実体がない")).category, "media-import-lost");
});

test("a vault index that denies a physically present directory still gets its log line", async () => {
  // Obsidian answers exists() from its index, which never learns about the
  // directories the importer creates through node fs. mkdir then throws for a
  // directory that is really there, and the log must still be written.
  const written = new Map<string, string>();
  const adapter = {
    async exists(): Promise<boolean> { return false; },
    async read(): Promise<string> { return ""; },
    async write(path: string, data: string): Promise<void> { written.set(path, data); },
    async mkdir(path: string): Promise<void> { throw new Error(`Folder already exists: ${path}`); },
  };
  const log = new DiagnosticLog(adapter, "XMediaArchive/_system");
  await log.log({ event: "plugin-loaded" });
  assert.match(written.get("XMediaArchive/_system/diagnostic.log") ?? "", /"event":"plugin-loaded"/);
});

test("diagnostic write failure never rejects the caller", async () => {
  const broken = { async exists() { return false; }, async read() { throw new Error("secret"); }, async write() { throw new Error("secret"); }, async mkdir() { throw new Error("secret"); } };
  await assert.doesNotReject(new DiagnosticLog(broken, "XMediaArchive/_system").log({ event: "test" }));
});
