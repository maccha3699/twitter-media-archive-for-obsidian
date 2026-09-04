import esbuild from "esbuild";

const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "node",
  target: "es2022",
  format: "cjs",
  external: ["obsidian"],
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info"
});
