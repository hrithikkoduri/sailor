/**
 * Integration tests must not share Redis with a running `npm run dev`.
 *
 * The dev stack consumes the `runs` queue on database 0. Tests move to
 * database 15, so a worker on the machine can never pick up a job a test just
 * enqueued (that was the worker-resume flake: it passed alone, timed out while
 * a dev worker was running). CI already passes `/15`; this only normalizes the
 * local default.
 */
const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
url.pathname = "/15";
process.env.REDIS_URL = url.toString();
