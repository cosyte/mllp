/**
 * MLLP Client typed errors and classifiers.
 *
 * Exports:
 * - `MllpTimeoutError`, ACK timeout
 * - `MllpBackpressureError`, high-water mark exceeded
 * - `MllpNeverDeliveredError`, a send that never reached the transport
 * - `MllpUnknownFateError`, a send whose bytes went out and drew no answer
 * - `isTransientConnectionError`, transient/permanent classifier
 *
 * Re-exported from `src/client/index.ts` and `src/index.ts`.
 *
 * @packageDocumentation
 */

/**
 * Thrown (or rejects the `send()` promise) when an ACK does not arrive within
 * the configured `ackTimeoutMs`.
 *
 * The timeout clock starts at the underlying `write()` flush callback, NOT
 * at the `send()` call, pre-flush queue time is not charged to the peer.
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpTimeoutError) {
 *     logger.warn({ elapsedMs: err.elapsedMs, idBytes: err.messageControlIdBytes });
 *   }
 * }
 * ```
 */
export class MllpTimeoutError extends Error {
  override readonly name = "MllpTimeoutError" as const;

  /**
   * Byte length of the timed-out send's MSH-10 control ID, or `undefined` when
   * there was none to read (FIFO mode, or a payload with no MSH-10).
   *
   * **The control ID itself is deliberately not here.** An `Error` is a
   * diagnostic surface: it is logged, and its `stack` is what an error reporter
   * ships off the box. MSH-10 is payload content, and a scanner that returns
   * the wrong field returns payload content of some other kind, which is how a
   * patient identifier reaches a log line. Nothing is lost by withholding it,
   * because this error rejects the very `send()` whose payload the caller
   * passed in, so the caller already holds the bytes. Control IDs are decoded
   * `latin1`, a 1:1 byte to code-unit map, so this count is a byte count.
   */
  readonly messageControlIdBytes: number | undefined;

  /** Milliseconds elapsed between write-flush and timeout fire. */
  readonly elapsedMs: number;

  /** Epoch ms timestamp recorded at write-flush callback. */
  readonly sentAt: number;

  /**
   * Construct an MLLP timeout error.
   *
   * @param message - Human-readable error message. Structural facts only, never field content.
   * @param opts - Timeout context (control-id byte length, elapsed time, flush timestamp).
   */
  constructor(
    message: string,
    opts: {
      messageControlIdBytes: number | undefined;
      elapsedMs: number;
      sentAt: number;
    },
  ) {
    super(message);
    this.messageControlIdBytes = opts.messageControlIdBytes;
    this.elapsedMs = opts.elapsedMs;
    this.sentAt = opts.sentAt;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpTimeoutError);
    }
  }
}

/**
 * Why a send waiting on its application acknowledgement was failed.
 *
 * - `'timeout'`, the wait that started at the accept acknowledgement expired.
 * - `'connection-lost'`, the link failed or was closed while the send was still pending on
 *   it. The send is failed rather than left pending or reported as successful, because
 *   nobody can say what the receiving application did with a message whose second
 *   acknowledgement never arrived.
 *
 * @example
 * ```typescript
 * import { MllpApplicationAckError } from '@cosyte/mllp';
 * if (err instanceof MllpApplicationAckError && err.reason === 'timeout') {
 *   // committed by the peer, application disposition unknown
 * }
 * ```
 */
export type ApplicationAckFailure = "timeout" | "connection-lost";

/**
 * Rejects a `send()` whose peer **committed** the message and then never reported what its
 * application did with it.
 *
 * This is the enhanced-mode outcome that has no original-mode counterpart, and it is
 * deliberately a distinct type from {@link MllpTimeoutError}: that one means "no
 * acknowledgement at all arrived", and this one means "the accept acknowledgement arrived,
 * the peer took custody, and the application acknowledgement did not follow". Confusing the
 * two would tell an operator a message may never have been received when the peer has said
 * in writing that it was.
 *
 * `commitCode` is the Table 0008 code already received, so a caller can act on the custody
 * transfer even though the application disposition is unknown. It is a member of a closed
 * six-code set, never wire content.
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpApplicationAckError) {
 *     logger.warn({ commit: err.commitCode, reason: err.reason, elapsedMs: err.elapsedMs });
 *   }
 * }
 * ```
 */
export class MllpApplicationAckError extends Error {
  override readonly name = "MllpApplicationAckError" as const;

  /** Why the wait ended. See {@link ApplicationAckFailure}. */
  readonly reason: ApplicationAckFailure;

  /** The commit disposition already received. Always the positive accept-mode code. */
  readonly commitCode: "CA";

  /**
   * Byte length of the send's MSH-10 control ID, or `undefined` when there was none to
   * read. The control ID itself is deliberately not here, for the reason given on
   * {@link MllpTimeoutError.messageControlIdBytes}.
   */
  readonly messageControlIdBytes: number | undefined;

  /** Milliseconds between the accept acknowledgement and this failure. */
  readonly elapsedMs: number;

  /** Epoch ms at which the accept acknowledgement was received. */
  readonly commitReceivedAt: number;

  /**
   * Construct an application-acknowledgement failure.
   *
   * @param message - Human-readable error message. Structural facts only, never field content.
   * @param opts - Failure context (why, the commit code, control-id byte length, timings).
   */
  constructor(
    message: string,
    opts: {
      reason: ApplicationAckFailure;
      commitCode: "CA";
      messageControlIdBytes: number | undefined;
      elapsedMs: number;
      commitReceivedAt: number;
    },
  ) {
    super(message);
    this.reason = opts.reason;
    this.commitCode = opts.commitCode;
    this.messageControlIdBytes = opts.messageControlIdBytes;
    this.elapsedMs = opts.elapsedMs;
    this.commitReceivedAt = opts.commitReceivedAt;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpApplicationAckError);
    }
  }
}

/**
 * Rejects a `send()` whose peer answered with a **negative commit**: HL7 Table 0008 `CE`
 * (commit error) or `CR` (commit reject).
 *
 * Either says the peer did not take custody of the bytes, so no application acknowledgement
 * is coming and there is nothing to wait for. The send fails immediately rather than sitting
 * out a window that would report the same failure later and less precisely.
 *
 * `commitCode` is a member of a closed six-code set, never wire content.
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpCommitRejectedError && err.commitCode === 'CR') {
 *     // the peer will not take this message; do not resend it unchanged
 *   }
 * }
 * ```
 */
export class MllpCommitRejectedError extends Error {
  override readonly name = "MllpCommitRejectedError" as const;

  /** The negative accept-mode code the peer sent. */
  readonly commitCode: "CE" | "CR";

  /**
   * Byte length of the send's MSH-10 control ID, or `undefined` when there was none to
   * read. The control ID itself is deliberately not here.
   */
  readonly messageControlIdBytes: number | undefined;

  /** Milliseconds between the send's write-flush and this acknowledgement. */
  readonly elapsedMs: number;

  /**
   * Construct a negative-commit error.
   *
   * @param message - Human-readable error message. Structural facts only, never field content.
   * @param opts - Failure context (the commit code, control-id byte length, elapsed time).
   */
  constructor(
    message: string,
    opts: {
      commitCode: "CE" | "CR";
      messageControlIdBytes: number | undefined;
      elapsedMs: number;
    },
  ) {
    super(message);
    this.commitCode = opts.commitCode;
    this.messageControlIdBytes = opts.messageControlIdBytes;
    this.elapsedMs = opts.elapsedMs;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpCommitRejectedError);
    }
  }
}

/**
 * The whole text of a {@link MllpNeverDeliveredError}, held here rather than composed at the
 * throw site.
 *
 * Fixed, and fixed on purpose: nothing input-derived may reach an error message, so the only
 * safe builder is one that takes no value at all. Everything this report has to say beyond
 * this sentence is a count, and a count travels on its own field.
 */
const NEVER_DELIVERED_MESSAGE =
  "delivery did not occur: the message was still held by the client and no bytes were written " +
  "to the transport, so the peer never saw it";

/**
 * The whole text of a {@link MllpUnknownFateError}. Fixed for the reason given on
 * {@link NEVER_DELIVERED_MESSAGE}, and here the reason is at its sharpest: this error reports
 * a message that WAS on the wire, so anything copied off it is payload content that has left
 * the building the moment an error reporter ships the box.
 */
const UNKNOWN_FATE_MESSAGE =
  "fate unknown: the message was written to the transport and no acknowledgement arrived " +
  "before the client finished closing, so whether the peer received it cannot be determined " +
  "from here";

/**
 * Rejects a `send()` whose bytes **never reached the transport**: the message was still held
 * inside the client when the client shut down, waiting for room in the send queue or for the
 * single in-flight slot.
 *
 * This is the safe half of a shutdown report. Nothing was written, so the peer cannot have
 * seen this message, cannot have committed it, and cannot produce a duplicate if the
 * application sends it again. It is deliberately a distinct type from
 * {@link MllpUnknownFateError}, so a caller decides between resending and escalating on
 * `instanceof` rather than on the wording of a message.
 *
 * Every field is a count. There is nothing else to carry: the caller passed the payload to
 * `send()` and still holds it.
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpNeverDeliveredError) {
 *     // safe to resend: these bytes were never written
 *     await backupClient.send(payload);
 *   }
 * }
 * ```
 */
export class MllpNeverDeliveredError extends Error {
  override readonly name = "MllpNeverDeliveredError" as const;

  /** Byte count of the framed message this send would have written. */
  readonly byteCount: number;

  /**
   * Byte length of the send's MSH-10 control ID, or `undefined` when there was none to read.
   * The control ID itself is deliberately not here, for the reason given on
   * {@link MllpTimeoutError.messageControlIdBytes}.
   */
  readonly messageControlIdBytes: number | undefined;

  /**
   * Construct a never-delivered report.
   *
   * There is no `message` parameter, deliberately: see {@link NEVER_DELIVERED_MESSAGE}.
   *
   * @param opts - Report context (framed byte count, control-id byte length).
   */
  constructor(opts: { byteCount: number; messageControlIdBytes: number | undefined }) {
    super(NEVER_DELIVERED_MESSAGE);
    this.byteCount = opts.byteCount;
    this.messageControlIdBytes = opts.messageControlIdBytes;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpNeverDeliveredError);
    }
  }
}

/**
 * Rejects a `send()` that **was** written to the transport and whose acknowledgement had still
 * not arrived when the client finished closing.
 *
 * The ambiguous half of a shutdown report, and it is reported as ambiguous because it is: an
 * acknowledgement lost on the way back is indistinguishable from a message the peer never
 * received. Nothing is retried automatically. HL7 makes the accept acknowledgement the thing
 * that releases a sender from resending, and puts the retransmission decision on the
 * application and on its peer's duplicate detection, keyed on MSH-10 plus MSH-7.
 *
 * Distinct from {@link MllpNeverDeliveredError} (nothing was written, so a resend is safe) and
 * from {@link MllpApplicationAckError} (the peer said in writing that it took custody, so a
 * resend would commit the message twice). Confusing the three is how a consumer's replay logic
 * either duplicates a clinical message or drops one.
 *
 * `flushedAt` is what a replay decision reasons about: it says when these bytes went out, so a
 * caller can compare it against the peer's own record.
 *
 * **Every field is a byte count or a timestamp, and the message is a constant.** No part of
 * the payload reaches this error, not the control ID, not a truncation of it, and not a hex
 * rendering. An `Error` is a diagnostic surface: it is logged, and its `stack` plus its own
 * properties are what an error reporter ships off the box.
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpUnknownFateError) {
 *     // do NOT blindly resend: the peer may already hold this message
 *     logger.warn({ flushedAt: err.flushedAt, bytes: err.byteCount });
 *   }
 * }
 * ```
 */
export class MllpUnknownFateError extends Error {
  override readonly name = "MllpUnknownFateError" as const;

  /** Epoch ms at which this send's bytes were written to the transport. */
  readonly flushedAt: number;

  /** Milliseconds between that write and this report. */
  readonly elapsedMs: number;

  /** Byte count of the framed message that was written. */
  readonly byteCount: number;

  /**
   * Byte length of the send's MSH-10 control ID, or `undefined` when there was none to read.
   * The control ID itself is deliberately not here, for the reason given on
   * {@link MllpTimeoutError.messageControlIdBytes}.
   */
  readonly messageControlIdBytes: number | undefined;

  /**
   * Construct an unknown-fate report.
   *
   * There is no `message` parameter, deliberately: see {@link UNKNOWN_FATE_MESSAGE}.
   *
   * @param opts - Report context (flush timestamp, elapsed time, byte counts).
   */
  constructor(opts: {
    flushedAt: number;
    elapsedMs: number;
    byteCount: number;
    messageControlIdBytes: number | undefined;
  }) {
    super(UNKNOWN_FATE_MESSAGE);
    this.flushedAt = opts.flushedAt;
    this.elapsedMs = opts.elapsedMs;
    this.byteCount = opts.byteCount;
    this.messageControlIdBytes = opts.messageControlIdBytes;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpUnknownFateError);
    }
  }
}

/**
 * Set of Node/OpenSSL error codes that indicate a **certificate-verification**
 * failure (as opposed to some other TLS handshake failure), untrusted chain,
 * expired/not-yet-valid certificate, hostname mismatch, revocation, etc.
 *
 * Used by `MllpClient` to classify a TLS connect failure's
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
 * Detects **TLS-protocol-shaped** errors, failures of the TLS protocol
 * itself, as opposed to plain TCP-level network failures.
 *
 * Apply this only to errors raised on a **TLS** connection; `MllpClient`
 * does exactly that (the predicate is consulted only when `ClientOptions.tls`
 * is set). The boundary:
 *
 * **TLS-protocol-shaped (`true`):**
 * - `code` starting `ERR_SSL_` (Node's TLS alert codes, e.g.
 *   `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, a `clientAuth: 'MUST'`
 *   server rejecting the client's certificate).
 * - `code === 'EPROTO'`, on a TLS connection this is OpenSSL failing the
 *   handshake (protocol version mismatch, no shared cipher, a TLS ≤1.2
 *   mTLS rejection).
 * - `message` containing `ssl` or `alert` (`/\bssl\b|\balert\b/i`, "SSL
 *   routines", "tlsv13 alert certificate required", …). This message check
 *   is a **heuristic backstop** over the code-based checks above, not a
 *   precise boundary: it exists to catch OpenSSL errors that surface without
 *   a usable `code`, and `MllpClient` consults it only on connections where
 *   TLS is configured. An arbitrary non-TLS error whose message happens to
 *   contain those words would also match.
 *
 * **NOT TLS-protocol-shaped (`false`), plain network failures, which stay
 * transient for the reconnect classifier:** `ECONNREFUSED`, `ETIMEDOUT`,
 * `EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`, and a plain `ECONNRESET` carrying
 * no TLS alert context, a network blip during (or after) a handshake
 * should still auto-heal.
 *
 * Certificate-**verification** failures are a separate class, see
 * {@link isTlsVerificationErrorCode}; `MllpClient` checks that first and
 * labels those `connectionCause: 'tls-verify'`.
 *
 * Why this matters: under TLS 1.3 (RFC 8446 §4.4.2) a `clientAuth: 'MUST'`
 * server can reject the client's certificate AFTER the client's own
 * `'secureConnect'`, the rejection then surfaces as a post-connect socket
 * error. A misconfigured mTLS client must never auto-reconnect-loop against
 * a server that will always reject it, so `MllpClient` classifies
 * TLS-protocol-shaped errors as **permanent**.
 *
 * @example
 * ```typescript
 * import { isTlsProtocolError, MllpConnectionError } from '@cosyte/mllp';
 * client.on('error', ({ error }) => {
 *   if (error instanceof MllpConnectionError && isTlsProtocolError(error.cause)) {
 *     // TLS protocol failure, a configuration problem, not a network blip.
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
 * Used internally by `MllpClient` BEFORE invoking `retryStrategy`
 * (see `RetryContext.classifiedAs`). Re-exported so callers can implement
 * their own retry policies.
 *
 * Classification table:
 * - `ENOTFOUND`, `EACCES` → **permanent** (`false`)
 * - `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`,
 *   `ENETUNREACH`, `EPIPE` → **transient** (`true`)
 * - `CERT_*` and `UNABLE_TO_VERIFY_LEAF_SIGNATURE` /
 *   `DEPTH_ZERO_SELF_SIGNED_CERT` / `SELF_SIGNED_CERT_IN_CHAIN`
 *   (any {@link isTlsVerificationErrorCode} code) → **permanent** (`false`),
 *   never auto-reconnect-loop into a misconfigured or MITM'd endpoint.
 * - `ERR_SSL_*` (Node TLS alert codes) → **permanent** (`false`), a TLS
 *   protocol failure such as a `clientAuth: 'MUST'` server rejecting the
 *   client certificate recurs on every attempt. On TLS-configured
 *   connections `MllpClient` additionally consults {@link isTlsProtocolError},
 *   which also catches `EPROTO`/alert-bearing OpenSSL errors that this
 *   generic classifier (which cannot know the connection was TLS) leaves
 *   transient.
 * - `MLLP_*` (any {@link MllpFramingError} code, a fatal decoder throw, surfaced with
 *   `connectionCause: 'framing-fatal'`) → **permanent** (`false`). The peer is not
 *   speaking MLLP, an HTTP probe, a health check, a wrong-port misconfiguration, or is emitting
 *   frames past `maxFrameSizeBytes`. Every reconnect meets the same bytes, so retrying is an
 *   unbounded storm against a peer that is already misconfigured. If a peer's quirk is *expected*,
 *   the decoder's tolerance opt-ins are the supported answer, they make it a warning, not a fatal.
 * - non-Error / unknown / no-code → **transient** (`true`), Postel's Law
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
      // A fatal MLLP framing error → permanent (MLLP-10). The peer is not speaking MLLP (an HTTP
      // probe, a health check, a wrong-port misconfiguration) or is emitting frames past the size
      // cap. Every reconnect meets the same bytes, so retrying is an unbounded reconnect storm
      // against a peer that is already misconfigured, the same reasoning that makes the TLS
      // classes permanent. A compatibility failure is not a network blip.
      if (code.startsWith("MLLP_")) return false;
      // Default: transient (Postel's Law, be permissive about peer behavior).
      return true;
  }
}

/**
 * Thrown (or rejects the `send()` promise) when the in-flight queue exceeds
 * the configured high-water mark and `onBackpressure: 'reject'` is set.
 *
 * `highWaterMark` accepts a count cap, a byte cap, or both, when both are
 * present, the stricter-of-two trigger wins.
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

  /** The high-water-mark configuration that was triggered. */
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
