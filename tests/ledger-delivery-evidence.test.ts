import { test, describe } from "node:test";
import * as assert from "node:assert";

import { summarizeVerifiedDelivery } from "../src/hooks/ledger-math.ts";

const counters = {
  hooks_fired: 3,
  hooks_failed: 1,
  injections_delivered: 2,
  injection_tokens_delivered: 25,
  per_hook: { "post-write.js": { fired: 3, failed: 1, last_exit: 1 } },
};

describe("summarizeVerifiedDelivery", () => {
  test("keeps legacy Claude counters exactly readable", () => {
    assert.deepStrictEqual(summarizeVerifiedDelivery(counters), counters);
  });

  test("includes confirmed and failed Claude provider receipts", () => {
    assert.deepStrictEqual(
      summarizeVerifiedDelivery({ ...counters, provider: "claude", status: "confirmed", variant: "claude_attachment" }),
      counters,
    );
    assert.deepStrictEqual(
      summarizeVerifiedDelivery({ ...counters, provider: "claude", status: "failed", variant: "claude_attachment" }),
      counters,
    );
  });

  test("rejects a forged Codex receipt that claims Claude attachment evidence", () => {
    assert.strictEqual(
      summarizeVerifiedDelivery({
        ...counters,
        provider: "codex",
        status: "confirmed",
        variant: "claude_attachment",
      } as any),
      null,
    );
  });

  test("excludes every unknown provider receipt instead of counting a zero", () => {
    assert.strictEqual(summarizeVerifiedDelivery({ provider: "codex", status: "unknown", variant: "unavailable" }), null);
    assert.strictEqual(summarizeVerifiedDelivery({ provider: "claude", status: "unknown", variant: "unavailable" }), null);
    assert.strictEqual(summarizeVerifiedDelivery({ provider: "unknown", status: "unknown", variant: "unavailable" }), null);
  });
});
