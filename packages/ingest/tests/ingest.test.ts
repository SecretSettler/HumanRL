import { describe, expect, it } from "vitest";

import { canonicalJson, decideIdempotency, payloadHash } from "../src/index.js";

describe("ingestion integrity", () => {
  it("hashes objects independently of key order", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(payloadHash({ a: 1, b: 2 })).toBe(payloadHash({ b: 2, a: 1 }));
  });

  it("distinguishes duplicate and conflicting source identities", () => {
    expect(decideIdempotency("same", { id: "event-1", payloadHash: "same" }).action).toBe(
      "duplicate",
    );
    expect(decideIdempotency("new", { id: "event-1", payloadHash: "old" }).action).toBe("conflict");
  });
});
