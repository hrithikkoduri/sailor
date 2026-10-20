/**
 * Build the E2B template Sailor's E2B backend boots.
 *
 *   E2B_API_KEY=... node scripts/build-e2b-template.mjs
 *   E2B_TEMPLATE=anchor-sailor-toolchain:latest
 *
 * Mirrors image/Dockerfile's userland without the Heyo-specific init/sshd
 * plumbing: git, Python 3 (+pip/pytest), Node 22 (+npm/corepack), ripgrep,
 * jq, and a native build toolchain. E2B boots a template, not a Docker image
 * at create time, so this is the one-time "machine image" step.
 */
import { Template, defaultBuildLogger } from "e2b";

const name = process.env.E2B_TEMPLATE ?? "anchor-sailor-toolchain:latest";
const cpuCount = Number(process.env.E2B_CPU_COUNT ?? 4);
const memoryMB = Number(process.env.E2B_MEMORY_MB ?? 8192);

const template = Template()
  .fromUbuntuImage("24.04")
  .runCmd([
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y --no-install-recommends ca-certificates curl wget git build-essential pkg-config cmake python3 python3-pip python3-venv python3-dev jq unzip zip less openssl tar ripgrep fd-find",
    "rm -rf /var/lib/apt/lists/*",
    // PEP 668: an agent sandbox wants `pip install -r requirements.txt` to work.
    "rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED",
    "ln -sf /usr/bin/python3 /usr/local/bin/python",
    "python3 -m pip install --no-cache-dir pytest",
    // Node 22 from NodeSource (Ubuntu's package is too old for modern repos).
    "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
    "apt-get install -y --no-install-recommends nodejs",
    "rm -rf /var/lib/apt/lists/*",
    "corepack enable",
    "ln -sf /usr/bin/fdfind /usr/local/bin/fd",
    "git config --system init.defaultBranch main",
    "git --version && python3 --version && node --version && npm --version && rg --version | head -1",
  ], { user: "root" });

console.log(`building E2B template "${name}" (${cpuCount} vCPU, ${memoryMB} MB)…`);
await Template.build(template, name, {
  cpuCount,
  memoryMB,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`built "${name}" — set E2B_TEMPLATE=${name}`);
