/**
 * MLLP Client typed errors and classifiers.
 *
 * Exports:
 * - `MllpTimeoutError` (PLAN-02) — ACK timeout (ERR-02)
 * - `MllpBackpressureError` — high-water mark exceeded (ERR-04, plan 05)
 * - `isTransientConnectionError` (PLAN-04) — transient/permanent classifier (CLIENT-18)
 *
 * Re-exported from `src/client/index.ts` and `src/index.ts`.
 *
 * @packageDocumentation
 */

/**
 * Thrown (or rejects the `send()` promise) when an ACK does not arrive within
 * the configured `ackTimeoutMs` (ERR-02).
 *
 * The timeout clock starts at the underlying `write()` flush callback, NOT
 * at the `send()` call — pre-flush queue time is not charged to the peer
 * (CLIENT-04).
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpTimeoutError) {
 *     logger.warn({ elapsedMs: err.elapsedMs, controlId: err.messageControlId });
 *   }
 * }
 * ```
 */
export class MllpTimeoutError extends Error {
  override readonly name = "MllpTimeoutError" as const;

  /** MSH-10 control ID of the timed-out send (FIFO mode: `undefined`). */
  readonly messageControlId: string | undefined;

  /** Milliseconds elapsed between write-flush and timeout fire. */
  readonly elapsedMs: number;

  /** Epoch ms timestamp recorded at write-flush callback. */
  readonly sentAt: number;

  /**
   * Construct an MLLP timeout error.
   *
   * @param message - Human-readable error message.
   * @param opts - Timeout context (originating message control id, elapsed time, flush timestamp).
   */
  constructor(
    message: string,
    opts: {
      messageControlId: string | undefined;
      elapsedMs: number;
      sentAt: number;
    },
  ) {
    super(message);
    this.messageControlId = opts.messageControlId;
    this.elapsedMs = opts.elapsedMs;
    this.sentAt = opts.sentAt;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpTimeoutError);
    }
  }
}

/**
 * Set of Node/OpenSSL error codes that indicate a **certificate-verification**
 * failure (as opposed to some other TLS handshake failure) — untrusted chain,
 * expired/not-yet-valid certificate, hostname mismatch, revocation, etc.
 *
 * Used by `MllpClient` (Phase 8) to classify a TLS connect failure's
 * `connectionCause` as `'tls-verify'` (this set) vs `'tls-handshake'`
 * (everything else observed before `'secureConnect'`). Exported so callers
 * can apply the same classification to their own error handling.
 *
 * @example
 * ```typescript
 * import { isTlsVerificationErrorCode } from '@cosyte/mllp';
 * if (isTlsVerificationErrorCode('CERT_HAS_EXPIRED')) {
 *   // definitely a verification failure, not a protocol/cipher mismatch
 * }
 * ```
 */
export function isTlsVerificationErrorCode(code: string): boolean {
  switch (code) {
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_GET_ISSUER_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "CERT_HAS_EXPIRED":
    case "CERT_NOT_YET_VALID":
    case "CERT_REVOKED":
    case "CERT_UNTRUSTED":
    case "CERT_REJECTED":
    case "CERT_SIGNATURE_FAILURE":
    case "HOSTNAME_MISMATCH":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return true;
    default:
      return code.startsWith("CERT_");
  }
}

/**
 * Detects **TLS-protocol-shaped** errors — failures of the TLS protocol
 * itself, as opposed to plain TCP-level network failures (Phase 8).
 *
 * Apply this only to errors raised on a **TLS** connection; `MllpClient`
 * does exactly that (the predicate is consulted only when `ClientOptions.tls`
 * is set). The boundary:
 *
 * **TLS-protocol-shaped (`true`):**
 * - `code` starting `ERR_SSL_` (Node's TLS alert codes, e.g.
 *   `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` — a `clientAuth: 'MUST'`
 *   server rejecting the client's certificate).
 * - `code === 'EPROTO'` — on a TLS connection this is OpenSSL failing the
 *   handshake (protocol version mismatch, no shared cipher, a TLS ≤1.2
 *   mTLS rejection).
 * - `message` containing `ssl` or `alert` (`/\bssl\b|\balert\b/i` — "SSL
 *   routines", "tlsv13 alert certificate required", …). This message check
 *   is a **heuristic backstop** over the code-based checks above, not a
 *   precise boundary: it exists to catch OpenSSL errors that surface without
 *   a usable `code`, and `MllpClient` consults it only on connections where
 *   TLS is configured. An arbitrary non-TLS error whose message happens to
 *   contain those words would also match.
 *
 * **NOT TLS-protocol-shaped (`false`) — plain network failures, which stay
 * transient for the reconnect classifier:** `ECONNREFUSED`, `ETIMEDOUT`,
 * `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`, and a plain `ECONNRESET` carrying
 * no TLS alert context — a network blip during (or after) a handshake
 * should still auto-heal.
 *
 * Certificate-**verification** failures are a separate class — see
 * {@link isTlsVerificationErrorCode}; `MllpClient` checks that first and
 * labels those `connectionCause: 'tls-verify'`.
 *
 * Why this matters: under TLS 1.3 (RFC 8446 §4.4.2) a `clientAuth: 'MUST'`
 * server can reject the client's certificate AFTER the client's own
 * `'secureConnect'` — the rejection then surfaces as a post-connect socket
 * error. A misconfigured mTLS client must never auto-reconnect-loop against
 * a server that will always reject it, so `MllpClient` classifies
 * TLS-protocol-shaped errors as **permanent**.
 *
 * @example
 * ```typescript
 * import { isTlsProtocolError, MllpConnectionError } from '@cosyte/mllp';
 * client.on('error', ({ error }) => {
 *   if (error instanceof MllpConnectionError && isTlsProtocolError(error.cause)) {
 *     // TLS protocol failure — a configuration problem, not a network blip.
 *   }
 * });
 * ```
 */
export function isTlsProtocolError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (code.startsWith("ERR_SSL_")) return true;
    if (code === "EPROTO") return true;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === "string" && /\bssl\b|\balert\b/i.test(message)) return true;
  return false;
}

/**
 * Classifies a connection error as transient (eligible for auto-reconnect)
 * or permanent (halts auto-reconnect, transitions to CLOSED).
 *
 * Used internally by `MllpClient` BEFORE invoking `retryStrategy` (Composition A
 * — see `RetryContext.classifiedAs`). Re-exported so callers can implement
 * their own retry policies.
 *
 * Classification table (CLIENT-18, D-16):
 * - `ENOTFOUND`, `EACCES` → **permanent** (`false`)
 * - `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`,
 *   `ENETUNREACH`, `EPIPE` → **transient** (`true`)
 * - `CERT_*` and `UNABLE_TO_VERIFY_LEAF_SIGNATURE` /
 *   `DEPTH_ZERO_SELF_SIGNED_CERT` / `SELF_SIGNED_CERT_IN_CHAIN`
 *   (any {@link isTlsVerificationErrorCode} code) → **permanent** (`false`) —
 *   never auto-reconnect-loop into a misconfigured or MITM'd endpoint (Phase 8).
 * - `ERR_SSL_*` (Node TLS alert codes) → **permanent** (`false`) — a TLS
 *   protocol failure such as a `clientAuth: 'MUST'` server rejecting the
 *   client certificate recurs on every attempt (Phase 8). On TLS-configured
 *   connections `MllpClient` additionally consults {@link isTlsProtocolError},
 *   which also catches `EPROTO`/alert-bearing OpenSSL errors that this
 *   generic classifier (which cannot know the connection was TLS) leaves
 *   transient.
 * - non-Error / unknown / no-code → **transient** (`true`) — Postel's Law
 *   default. Reconnect attempts are bounded by `retryStrategy` and the
 *   30s backoff cap, so the default is safe.
 *
 * @example
 * ```typescript
 * import { isTransientConnectionError } from '@cosyte/mllp';
 * client.on('error', (err) => {
 *   if (isTransientConnectionError(err)) {
 *     metrics.increment('mllp.transient_error');
 *   } else {
 *     metrics.increment('mllp.permanent_error');
 *   }
 * });
 * ```
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return true;
  switch (code) {
    case "ENOTFOUND":
    case "EACCES":
      return false;
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EPIPE":
      return true;
    default:
      // TLS cert error codes (CERT_*) and *_VERIFY_* names → permanent.
      if (isTlsVerificationErrorCode(code)) return false;
      // Node TLS alert codes → permanent (Phase 8; recur on every attempt).
      if (code.startsWith("ERR_SSL_")) return false;
      // Default: transient (Postel's Law — be permissive about peer behavior).
      return true;
  }
}

/**
 * Thrown (or rejects the `send()` promise) when the in-flight queue exceeds
 * the configured high-water mark and `onBackpressure: 'reject'` is set
 * (CLIENT-07, ERR-04).
 *
 * `highWaterMark` accepts a count cap, a byte cap, or both — when both are
 * present, the stricter-of-two trigger wins (D-23).
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpBackpressureError) {
 *     logger.warn({
 *       queueDepth: err.queueDepth,
 *       queueBytes: err.queueBytes,
 *       cap: err.highWaterMark,
 *     });
 *   }
 * }
 * ```
 */
export class MllpBackpressureError extends Error {
  override readonly name = "MllpBackpressureError" as const;

  /** Number of in-flight + queued sends at the moment of rejection. */
  readonly queueDepth: number;

  /** Total bytes of in-flight + queued frames at the moment of rejection. */
  readonly queueBytes: number;

  /** The high-water-mark configuration that was triggered (D-23). */
  readonly highWaterMark: { readonly count?: number; readonly bytes?: number };

  /**
   * Construct an MLLP backpressure error.
   *
   * @param message - Human-readable error message.
   * @param opts - Backpressure context (queue depth, queued bytes, the high-water-mark hit).
   */
  constructor(
    message: string,
    opts: {
      queueDepth: number;
      queueBytes: number;
      highWaterMark: { count?: number; bytes?: number };
    },
  ) {
    super(message);
    this.queueDepth = opts.queueDepth;
    this.queueBytes = opts.queueBytes;
    this.highWaterMark = opts.highWaterMark;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpBackpressureError);
    }
  }
}
