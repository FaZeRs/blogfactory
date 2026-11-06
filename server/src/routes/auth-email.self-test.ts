import assert from "node:assert/strict";
import { normalizeEmail } from "./auth.js";

assert.equal(normalizeEmail("  Owner@Example.COM "), "owner@example.com");

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES === "1") {
  assert.ok(!/\/blogfactory$/.test(process.env.DATABASE_URL ?? ""), "refusing the shared database");
  const { randomUUID } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db/index.js");
  const { users } = await import("../db/schema.js");
  const email = `case-${randomUUID()}@example.test`;
  const [user] = await db.insert(users).values({ email, passwordHash: "x" }).returning();
  try {
    // Migration 0044: a differently-cased duplicate cannot register beside an existing account.
    await assert.rejects(db.insert(users).values({ email: email.toUpperCase(), passwordHash: "x" }));
  } finally {
    await db.delete(users).where(eq(users.id, user!.id));
  }
}
console.log("auth email self-test passed");
process.exit(0);
