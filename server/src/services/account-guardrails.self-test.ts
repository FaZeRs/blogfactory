import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://blogfactory:blogfactory@localhost:5432/blogfactory";

const { guardrailDecision } = await import("./account-guardrails.js");

const usage = { monthSpend: 0, todaySpend: 0, todayRequests: 0, todayFailures: 0 };

assert.deepEqual(guardrailDecision(null, usage), { blocked: false });
assert.deepEqual(guardrailDecision({ monthlyBudget: 10 }, { ...usage, monthSpend: 9.99 }), { blocked: false });

assert.deepEqual(guardrailDecision({ budgetPaused: true }, usage), {
  blocked: true, message: "Generation paused — monthly budget exceeded", error: "Budget exceeded", latchMonthly: false,
});
assert.deepEqual(guardrailDecision({ monthlyBudget: 10 }, { ...usage, monthSpend: 10 }), {
  blocked: true, message: "Monthly budget exceeded — generation paused", error: "Budget exceeded", latchMonthly: true,
});

const cost = guardrailDecision({ dailyCostLimit: 5 }, { ...usage, todaySpend: 5 });
assert.equal(cost.blocked && cost.latchMonthly, false);
assert.ok(cost.blocked && cost.message.startsWith("Daily spend ceiling reached — $5.00 of $5.00 today."));
assert.ok(cost.blocked && cost.error === cost.message);

const reqs = guardrailDecision({ dailyRequestLimit: 3 }, { ...usage, todayRequests: 3 });
assert.ok(reqs.blocked && reqs.message.startsWith("Daily request ceiling reached — 3 of 3 model calls today."));

// Monthly takes precedence over daily.
assert.ok(guardrailDecision({ monthlyBudget: 1, dailyCostLimit: 1 }, { ...usage, monthSpend: 2, todaySpend: 2 }).blocked);
assert.equal((guardrailDecision({ monthlyBudget: 1, dailyCostLimit: 1 }, { ...usage, monthSpend: 2, todaySpend: 2 }) as { latchMonthly: boolean }).latchMonthly, true);

console.log("account-guardrails self-test passed");
