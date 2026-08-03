/**
 * Byte-equality assertion for LARGE buffers.
 *
 * `expect(a).toEqual(b)` on two Buffers walks them element by element in JS.
 * On this suite's biggest payloads that is the whole cost of the test: measured
 * on a 1 MiB pair it took seconds, against tens of milliseconds for the encode +
 * decode round trip the test actually exists to exercise. `Buffer.equals` is a
 * native memcmp, so the comparison stops being the subject.
 *
 * The trade `toEqual` would otherwise buy is a readable diff, so this reports the
 * first differing offset and both bytes at it. On a megabyte of pseudo-random
 * bytes that is more useful than a truncated structural diff anyway.
 *
 * Use it only where the size makes it worth the indirection. A short payload is
 * clearer as a plain `toEqual`, and every other assertion in the suite stays that
 * way on purpose.
 */
import { expect } from "vitest";

/** Assert two buffers hold identical bytes, without a per-element JS comparison. */
export function expectBytesEqual(actual: Buffer, expected: Buffer, what: string): void {
  if (actual.equals(expected)) return;

  if (actual.length !== expected.length) {
    expect.fail(`${what}: length ${actual.length} != expected ${expected.length}`);
  }
  let at = -1;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      at = i;
      break;
    }
  }
  expect.fail(
    `${what}: first difference at byte ${at} (got 0x${(actual[at] ?? 0).toString(16)}, ` +
      `expected 0x${(expected[at] ?? 0).toString(16)}), length ${actual.length}`,
  );
}
