import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(process.cwd(), "node_modules/@electric-sql/pglite/dist");
const dest = join(process.cwd(), ".vercel/output/functions/__server.func/_libs");
if (!existsSync(dest)) process.exit(0);
for (const name of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
  copyFileSync(join(srcDir, name), join(dest, name));
}
console.log("copied pglite runtime assets next to the server bundle");
