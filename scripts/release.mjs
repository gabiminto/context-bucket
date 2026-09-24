import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
const result = spawnSync(process.execPath, ["esbuild.config.mjs", "production", "--outfile", "dist/main.js"], {
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
for (const file of ["manifest.json", "styles.css", "README.md"]) {
  await cp(file, `dist/${file}`);
}
console.log("Installable plugin written to dist/");
