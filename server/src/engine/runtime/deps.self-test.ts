import assert from "node:assert/strict";

if (process.env.POSTGRES_INTEGRATION_ALLOW_WRITES !== "1") {
  console.log("dataforseo spend self-test skipped (set POSTGRES_INTEGRATION_ALLOW_WRITES=1 with a test DATABASE_URL)");
} else {
  if (/\/blogfactory$/.test(process.env.DATABASE_URL ?? "")) throw new Error("refusing to run against the shared blogfactory database");
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../../db/index.js");
  const { providerSpend } = await import("../../db/schema.js");
  const { dataForSeoSpend } = await import("./deps.js");
  const month = new Date().toISOString().slice(0, 7);
  const row = and(eq(providerSpend.provider, "dataforseo"), eq(providerSpend.month, month));
  const spent = async () => (await db.select().from(providerSpend).where(row))[0]?.usd ?? 0;

  await db.delete(providerSpend).where(row);
  try {
    // 20 concurrent 0.01 reservations against a 0.05 cap: exactly 5 land, never more.
    const results = await Promise.all(Array.from({ length: 20 }, () => dataForSeoSpend.reserve(0.01, 0.05)));
    const landed = results.filter((r) => r !== null);
    assert.equal(landed.length, 5);
    assert.ok(Math.abs((await spent()) - 0.05) < 1e-9);
    // settling swaps the estimate for the billed cost; 0 releases it
    await landed[0]!(0.004);
    await landed[1]!(0);
    assert.ok(Math.abs((await spent()) - 0.034) < 1e-9);
    assert.equal(await dataForSeoSpend.reserve(1, 0.05), null, "an estimate above the cap never lands");
    console.log("dataforseo spend self-test ok");
  } finally {
    await db.delete(providerSpend).where(row);
  }
  process.exit(0);
}
