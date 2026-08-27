/**
 * The stable warning-code set is a public API, and the differential harness may only name
 * a deviation with a code from it.
 *
 * `src/framing/registry.ts` says so in as many words: renaming or removing a code is a
 * breaking change, and new codes may only be added in a minor version. Every consumer log
 * pipeline, dashboard and alert rule keyed to one of these strings breaks the day it moves,
 * and none of them is visible from this repository.
 *
 * So this suite pins the set from BOTH sides:
 *
 *   - the eleven codes the shipped union declared before the harness existed must still be
 *     there, spelled exactly as they were. That is the no-rename, no-removal half;
 *   - every `MLLP_*` literal in the harness's DEVIATION-naming sources must be a member of
 *     the shipped union. That is the additive-only half: a harness that invents a code, or
 *     misspells one, reds here rather than in a consumer's dashboard.
 *
 * `src/differential/error.ts` is deliberately excluded from the second half, and is checked
 * separately below. A **configuration** error code is its own stable namespace, exactly as
 * the TLS-configuration codes and the security-warning codes are: it names a mistake in
 * someone's settings, not a deviation a peer presented, and it is not a `WarningCode`. What
 * is checked there is that the two namespaces do not collide.
 *
 * The union is read off the source text rather than off a runtime array on purpose. There
 * is no runtime array, adding one would be a new public surface with its own stability
 * promise, and the declaration in the source is the thing the promise is actually about.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const REGISTRY = join(ROOT, "src", "framing", "registry.ts");
const DIFFERENTIAL_DIR = join(ROOT, "src", "differential");

/**
 * The eleven codes the shipped `WarningCode` union declared before this harness was built,
 * transcribed here rather than derived, because a derived list cannot detect a rename: it
 * would simply follow it.
 */
const CODES_AT_THE_PIN: readonly string[] = [
  "MLLP_ACK_AFTER_TIMEOUT",
  "MLLP_ACK_UNMATCHED_CONTROL_ID",
  "MLLP_EMPTY_PAYLOAD",
  "MLLP_FRAME_TOO_LARGE",
  "MLLP_FS_WITHOUT_CR",
  "MLLP_LEADING_WHITESPACE",
  "MLLP_LF_AFTER_FS",
  "MLLP_MISSING_LEADING_VT",
  "MLLP_PAYLOAD_CONTAINS_FS",
  "MLLP_PAYLOAD_CONTAINS_VT",
  "MLLP_TRAILING_BYTES",
];

/** The stable warning codes the shipped `WarningCode` union declares, read off the source. */
function shippedWarningCodes(): string[] {
  const source = readFileSync(REGISTRY, "utf8");
  const start = source.indexOf("export type WarningCode =");
  if (start === -1) {
    throw new Error("src/framing/registry.ts no longer declares `export type WarningCode =`.");
  }
  const end = source.indexOf(";", start);
  const block = source.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/"(MLLP_[A-Z0-9_]+)"/g)].map((m) => m[1] ?? "").sort();
}

/** The one source that owns the harness's own configuration-error codes. */
const CONFIGURATION_ERROR_SOURCE = "error.ts";

/**
 * Every `MLLP_*` literal in the harness's deviation-naming sources, with its file. The
 * configuration-error registry is excluded: its codes are a separate stable namespace and
 * are checked on their own terms below.
 */
function differentialCodeLiterals(): { readonly file: string; readonly code: string }[] {
  const out: { file: string; code: string }[] = [];
  for (const name of readdirSync(DIFFERENTIAL_DIR).sort()) {
    if (name === CONFIGURATION_ERROR_SOURCE) continue;
    const source = readFileSync(join(DIFFERENTIAL_DIR, name), "utf8");
    for (const m of source.matchAll(/"(MLLP_[A-Z0-9_]+)"/g)) {
      out.push({ file: `src/differential/${name}`, code: m[1] ?? "" });
    }
  }
  return out;
}

/** The harness's own configuration-error codes, read off their registry. */
function configurationErrorCodes(): string[] {
  const source = readFileSync(join(DIFFERENTIAL_DIR, CONFIGURATION_ERROR_SOURCE), "utf8");
  return [...source.matchAll(/^export const (MLLP_[A-Z0-9_]+) =/gm)].map((m) => m[1] ?? "").sort();
}

describe("the stable warning-code set survives this work", () => {
  it("still declares every code that was published, spelled exactly as it was", () => {
    const shipped = shippedWarningCodes();
    for (const code of CODES_AT_THE_PIN) {
      expect(
        shipped,
        `${code} is a published warning code. Renaming or removing one is a breaking change ` +
          `for every consumer log pipeline keyed to it.`,
      ).toContain(code);
    }
  });

  it("adds codes only, never replaces them", () => {
    const shipped = shippedWarningCodes();
    // Nothing was dropped: the pinned set is a subset. Anything extra is a pure addition,
    // which the union is explicitly allowed to take in a minor version.
    const missing = CODES_AT_THE_PIN.filter((c) => !shipped.includes(c));
    expect(missing).toEqual([]);
    expect(shipped.length).toBeGreaterThanOrEqual(CODES_AT_THE_PIN.length);
  });

  it("names every deviation from that set and invents none", () => {
    const shipped = new Set(shippedWarningCodes());
    const literals = differentialCodeLiterals();
    // The harness names at least one code directly; the rest arrive typed from the codec.
    expect(literals.length).toBeGreaterThan(0);
    for (const { file, code } of literals) {
      expect(
        shipped.has(code),
        `${file} names ${code}, which is not a member of the shipped WarningCode union in ` +
          `src/framing/registry.ts.`,
      ).toBe(true);
    }
  });

  it("keeps the correlation failure on the ACK-correlation code, not a framing one", () => {
    const codes = new Set(differentialCodeLiterals().map((l) => l.code));
    expect(codes).toContain("MLLP_ACK_UNMATCHED_CONTROL_ID");
  });

  it("keeps the configuration-error namespace separate from the warning-code union", () => {
    const shipped = new Set(shippedWarningCodes());
    const configuration = configurationErrorCodes();
    expect(configuration).toEqual(["MLLP_DIFF_PEER_UNPARSEABLE"]);
    for (const code of configuration) {
      expect(
        shipped.has(code),
        `${code} is a configuration-error code and must not also be a WarningCode: a caller ` +
          `branching on one would then be branching on the other.`,
      ).toBe(false);
    }
  });
});
