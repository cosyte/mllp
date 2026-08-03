/**
 * The helper this file tests replaced `toEqual` on the suite's two largest byte
 * comparisons. A comparison helper that cannot fail is worse than the assertion it
 * replaced, so each way it must red is pinned here: a differing byte, a differing
 * length, and a prefix (the case a naive length-only or first-byte-only check
 * would wave through).
 */
import { describe, it, expect } from "vitest";

import { expectBytesEqual } from "./bytes.js";

describe("expectBytesEqual", () => {
  it("passes on identical bytes, including two distinct Buffer instances", () => {
    const a = Buffer.from([0x01, 0x02, 0x03]);
    expectBytesEqual(Buffer.from(a), a, "copy");
  });

  it("passes on two empty buffers", () => {
    expectBytesEqual(Buffer.alloc(0), Buffer.alloc(0), "empty");
  });

  it("FAILS on a single differing byte, naming the offset and both values", () => {
    const expected = Buffer.alloc(4096, 0x41);
    const actual = Buffer.from(expected);
    actual[2048] = 0x42;
    expect(() => expectBytesEqual(actual, expected, "one byte")).toThrow(
      /one byte: first difference at byte 2048 \(got 0x42, expected 0x41\)/,
    );
  });

  it("FAILS on a length difference, naming both lengths", () => {
    const expected = Buffer.alloc(10, 0x41);
    expect(() => expectBytesEqual(Buffer.alloc(9, 0x41), expected, "short")).toThrow(
      /short: length 9 != expected 10/,
    );
  });

  it("FAILS on a truncated prefix rather than reading it as equal", () => {
    // The decoder failure this guards against: a frame delivered with its tail
    // missing. Every byte compared so far matched.
    const expected = Buffer.from("MSH|^~\\&|SEND|FAC", "latin1");
    expect(() => expectBytesEqual(expected.subarray(0, 8), expected, "prefix")).toThrow(
      /prefix: length 8 != expected 17/,
    );
  });
});
