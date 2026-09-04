import { runBrowserBenchmark } from "./browser_benchmark_runner.mjs";

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return parsed;
}

const posts = positiveInt(process.argv[2], 816, "post count");
const media = positiveInt(process.argv[3], 940, "media count");
const concurrency = positiveInt(process.argv[4], 20, "concurrency");

await runBrowserBenchmark({
  pageName: "job_read_benchmark.html",
  searchParams: { posts, media, concurrency },
});
