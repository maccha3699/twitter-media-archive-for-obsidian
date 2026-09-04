import { runBrowserBenchmark } from "./browser_benchmark_runner.mjs";

const count = Number(process.argv[2] ?? 100000);
if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("count must be a positive safe integer");

await runBrowserBenchmark({
  pageName: "indexeddb_benchmark.html",
  searchParams: { count },
});
