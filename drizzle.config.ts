import { defineConfig } from "drizzle-kit";

// `npm run db:generate` diffs src/db/schema.ts against the last snapshot and
// writes a plain-SQL migration into /drizzle (which stays in the repo and in
// code review). `npm run migrate` applies it to the database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://harness:harness@localhost:5432/harness",
  },
});
