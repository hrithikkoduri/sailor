/**
 * Build and publish the Sailor toolchain as an E2B template.
 *
 *   E2B_API_KEY=... node image/build-e2b.mjs
 *   # name defaults to sailor-toolchain:latest; override with E2B_TEMPLATE
 *
 * This is the E2B counterpart of `image/build.sh --push`: one environment,
 * built once, referenced by name (`E2B_TEMPLATE`) instead of being rebuilt
 * per sandbox. E2B boots templates, not Docker images.
 */
import { Template, defaultBuildLogger } from "e2b";

const name = process.env.E2B_TEMPLATE ?? "sailor-toolchain:latest";
const cpuCount = Number(process.env.E2B_CPU_COUNT ?? 2);
const memoryMB = Number(process.env.E2B_MEMORY_MB ?? 2048);

if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is not set — add it to .env or pass it inline");
  process.exit(1);
}

const template = Template().fromDockerfile("image/e2b.Dockerfile");

console.log(`building E2B template "${name}" (${cpuCount} vCPU, ${memoryMB} MB)`);
await Template.build(template, name, {
  cpuCount,
  memoryMB,
  onBuildLogs: defaultBuildLogger(),
});
console.log(`built "${name}" — set E2B_TEMPLATE=${name} in .env`);
