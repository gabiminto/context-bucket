import { builtinModules } from "node:module";
import esbuild from "esbuild";

const production = process.argv.includes("production");
const outfileIndex = process.argv.indexOf("--outfile");
const outfile = outfileIndex >= 0 ? process.argv[outfileIndex + 1] : "main.js";
if (!outfile) throw new Error("--outfile requires a path");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    "node:child_process",
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile,
  minify: production,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
