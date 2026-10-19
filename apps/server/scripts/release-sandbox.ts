/**
 * One-off ops helper: release a retained sandbox by id, using the product's
 * own provider wiring. Run from apps/server:
 *
 *   npx tsx scripts/release-sandbox.ts sb-anchor-xxxx
 */
import { releaseSandbox } from "anchor-ai-sdk";
import { heyoProvider } from "../src/heyo-provider.js";
import { loadConfig, loadDotEnv } from "../src/config.js";

loadDotEnv(); // fill from .env — loadConfig alone never does (the CLI calls this)

const id = process.argv[2];
if (!id) throw new Error("usage: tsx scripts/release-sandbox.ts <sandbox-id>");
const provider = heyoProvider(loadConfig());
await releaseSandbox({ id, backend: provider.name }, provider);
console.log(`released ${id} via ${provider.name}`);
