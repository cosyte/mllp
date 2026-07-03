/**
 * Lazy loader for the optional `@cosyte/hl7` peer dependency.
 *
 * `@cosyte/mllp` ships **zero runtime dependencies**; `@cosyte/hl7` is an
 * optional peer dep referenced only from this `/ack-from-hl7` subpath. To keep
 * the rest of the package fully dependency-free, the peer is required lazily —
 * on first call into `ack-from-hl7` — via `createRequire`, not at module load
 * time. The public API of this subpath stays synchronous throughout.
 *
 * @example
 * ```typescript
 * import { loadHl7Peer } from '@cosyte/mllp/ack-from-hl7';
 * const hl7 = loadHl7Peer(); // throws MllpPeerMissingError if not installed
 * ```
 *
 * @packageDocumentation
 */

import { createRequire } from "node:module";

import type {
  ACK_CODES,
  AckCode,
  BuildAckOptions,
  FATAL_CODES,
  Hl7Message as Hl7MessageType,
  Hl7ParseError as Hl7ParseErrorType,
} from "@cosyte/hl7";

/**
 * The subset of the `@cosyte/hl7` runtime surface the `ack-from-hl7` adapter
 * consumes. Kept narrow and typed via `import type` (erased at compile time)
 * so the runtime dependency stays fully lazy — only the shape is known
 * statically, the values are resolved via `require()` at first call.
 *
 * @example
 * ```typescript
 * import type { Hl7Peer } from '@cosyte/mllp/ack-from-hl7';
 * function useAck(peer: Hl7Peer) {
 *   return peer.buildAck;
 * }
 * ```
 */
export interface Hl7Peer {
  readonly parseHL7: (raw: string | Buffer) => Hl7MessageType;
  readonly buildAck: (inbound: Hl7MessageType, options: BuildAckOptions) => Hl7MessageType;
  readonly detectAckMode: (inbound: Hl7MessageType) => "original" | "enhanced";
  readonly buildMessage: (init: { readonly type: string }) => Hl7MessageType;
  /**
   * The peer's own `Hl7Message` class. Exposed (not just used as a type) so
   * callers can detect a cross-realm instance — see the dual-package-hazard
   * note on `resolveInbound` in `build.ts`. Typed as `abstract new` (rather
   * than a concrete constructor signature) purely so TypeScript accepts it as
   * an `instanceof` right-hand side without also implying callers can `new`
   * it directly with arbitrary args.
   */
  readonly Hl7Message: abstract new (...args: never[]) => Hl7MessageType;
  readonly Hl7ParseError: typeof Hl7ParseErrorType;
  readonly FATAL_CODES: typeof FATAL_CODES;
  readonly ACK_CODES: typeof ACK_CODES;
  /**
   * The peer's fail-safe downgrade primitive (`AA`→`AE`, `CA`→`CE`, everything
   * else unchanged) — the single upstream source of truth for the pair; this
   * adapter never carries its own copy of the mapping.
   */
  readonly downgradePositiveAck: (code: AckCode) => AckCode;
}

/** The subpath's own name, used in {@link MllpPeerMissingError}'s message. */
const SUBPATH_NAME = "@cosyte/mllp/ack-from-hl7";

/** The peer package name, as seen by Node module resolution. */
const PEER_PACKAGE_NAME = "@cosyte/hl7";

/** Node error codes that indicate a module could not be found at all. */
const MODULE_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
]);

/**
 * Thrown when `@cosyte/hl7` — the optional peer dependency required by
 * `@cosyte/mllp/ack-from-hl7` — cannot be resolved at runtime.
 *
 * `@cosyte/hl7` is declared as an optional peer dependency, so a consumer of
 * the root `@cosyte/mllp` entry point is never forced to install it. Only
 * code that imports from the `/ack-from-hl7` subpath needs it, and only once
 * that code actually runs (the loader is lazy).
 *
 * @example
 * ```typescript
 * import { buildAckAA, MllpPeerMissingError } from '@cosyte/mllp/ack-from-hl7';
 * try {
 *   buildAckAA(inboundBuffer);
 * } catch (err) {
 *   if (err instanceof MllpPeerMissingError) {
 *     console.error(err.message); // explains how to install @cosyte/hl7
 *   }
 * }
 * ```
 */
export class MllpPeerMissingError extends Error {
  override readonly name = "MllpPeerMissingError" as const;

  /** Stable machine-readable code identifying this error class. */
  readonly code = "MLLP_PEER_MISSING" as const;

  /**
   * Construct an `MllpPeerMissingError`.
   *
   * @param cause - The original module-resolution error, preserved for debugging.
   */
  constructor(cause: unknown) {
    super(
      `${PEER_PACKAGE_NAME} is required by ${SUBPATH_NAME} but is not installed. ` +
        `${PEER_PACKAGE_NAME} is an optional peer dependency of @cosyte/mllp — install it ` +
        `alongside @cosyte/mllp to use ${SUBPATH_NAME}: \`npm install ${PEER_PACKAGE_NAME}\` ` +
        `(or the equivalent for your package manager).`,
      { cause },
    );
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpPeerMissingError);
    }
  }
}

/** Cached peer module, populated on first successful {@link loadHl7Peer} call. */
let cachedPeer: Hl7Peer | undefined;

/**
 * Matches the *quoted unresolvable module id* in Node's resolution-failure
 * messages — `Cannot find module '@cosyte/hl7'` (CJS) / `Cannot find package
 * '@cosyte/hl7'` (ESM). Anchoring on the quoted id (rather than a bare
 * substring test) keeps a module-not-found thrown from *inside* `@cosyte/hl7`
 * — whose message names a different module but whose require-stack still
 * contains the peer's path — propagating unchanged: that is a real bug in the
 * installed peer, not a missing peer.
 * @internal
 */
const PEER_UNRESOLVABLE_RE = /Cannot find (?:module|package) '@cosyte\/hl7'/;

/**
 * True iff `err` is a Node "module could not be resolved" error specifically
 * for the `@cosyte/hl7` peer package itself.
 * @internal
 */
function isPeerModuleNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || !MODULE_NOT_FOUND_CODES.has(code)) return false;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && PEER_UNRESOLVABLE_RE.test(message);
}

/**
 * Load the `@cosyte/hl7` peer module, caching the result for subsequent
 * calls. The public adapter functions in `build.ts` call this internally —
 * most consumers never call it directly.
 *
 * @param requireFn - Injectable `require`-like function, used by tests to
 *   simulate a missing peer without actually uninstalling it. Defaults to a
 *   real `createRequire(import.meta.url)`.
 * @internal
 *
 * @example
 * ```typescript
 * import { loadHl7Peer } from '@cosyte/mllp/ack-from-hl7';
 * const hl7 = loadHl7Peer();
 * const ack = hl7.buildAck(hl7.parseHL7(raw), { code: "AA" });
 * ```
 */
export function loadHl7Peer(requireFn?: (id: string) => unknown): Hl7Peer {
  if (cachedPeer !== undefined && requireFn === undefined) {
    return cachedPeer;
  }

  const doRequire = requireFn ?? createRequire(import.meta.url);

  let mod: unknown;
  try {
    mod = doRequire(PEER_PACKAGE_NAME);
  } catch (err) {
    if (isPeerModuleNotFound(err)) {
      throw new MllpPeerMissingError(err);
    }
    throw err;
  }

  const peer = mod as Hl7Peer;
  if (requireFn === undefined) {
    cachedPeer = peer;
  }
  return peer;
}
