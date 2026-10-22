/**
 * Pack @sailor/contracts into artifacts/ for consumption without npm.
 *
 * The package stays private; this tarball is the distribution boundary for the
 * private cloud layer (and any other checkout that cannot use the workspace).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "artifacts");
mkdirSync(out, { recursive: true });

const output = execFileSync(
  "npm",
  ["pack", "-w", "packages/contracts", "--pack-destination", out],
  { cwd: root, encoding: "utf8" },
);
process.stdout.write(output);
process.stdout.write(`tarball written to ${out}\n`);
