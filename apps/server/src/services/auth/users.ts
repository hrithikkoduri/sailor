/**
 * User rows — creation + linking (decision #41).
 *
 * First GitHub login = signup (upsert by `github_user_id`). When GitHub
 * provides a verified email that matches an existing email account, the two
 * are linked onto the same user row.
 */
import { eq } from "drizzle-orm";
import { schema, type Db } from "../../db/index.js";
import type { GithubIdentity } from "./github-oauth.js";

export function publicUser(user: typeof schema.users.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
  };
}

export async function findUserByEmail(db: Db, email: string) {
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  return user;
}

export async function createEmailUser(db: Db, email: string, passwordHash: string) {
  const [user] = await db.insert(schema.users).values({ email, passwordHash }).returning();
  return user!;
}

export async function upsertGithubUser(db: Db, identity: GithubIdentity) {
  const [byGithub] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.githubUserId, identity.id));
  if (byGithub) {
    const [updated] = await db
      .update(schema.users)
      .set({
        login: identity.login,
        name: identity.name,
        avatarUrl: identity.avatar_url,
        ...(identity.email && !byGithub.email ? { email: identity.email } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, byGithub.id))
      .returning();
    return updated!;
  }

  // Link to an email account when GitHub gives us the same verified email.
  if (identity.email) {
    const byEmail = await findUserByEmail(db, identity.email);
    if (byEmail) {
      const [linked] = await db
        .update(schema.users)
        .set({
          githubUserId: identity.id,
          login: identity.login,
          name: identity.name,
          avatarUrl: identity.avatar_url,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, byEmail.id))
        .returning();
      return linked!;
    }
  }

  const [created] = await db
    .insert(schema.users)
    .values({
      email: identity.email,
      githubUserId: identity.id,
      login: identity.login,
      name: identity.name,
      avatarUrl: identity.avatar_url,
    })
    .returning();
  return created!;
}

/** The dev-bypass user (decision #43) — created on first use, never in prod. */
export async function ensureDevUser(db: Db) {
  const email = "dev@localhost";
  const existing = await findUserByEmail(db, email);
  if (existing) return existing;
  await db.insert(schema.users).values({ email, name: "Dev" }).onConflictDoNothing();
  const user = await findUserByEmail(db, email);
  if (!user) throw new Error("dev user vanished mid-insert");
  return user;
}
