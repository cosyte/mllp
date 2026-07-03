/**
 * Security-warning codes and payload shape shared by the client and server (Phase 8).
 *
 * These codes are a **public API** — they appear in `'securityWarning'` event
 * handlers, log pipelines, and monitoring dashboards. Renaming or removing a
 * code is a breaking change (mirrors the `WarningCode` guardrail in
 * `src/framing/registry.ts`).
 *
 * @example
 * ```typescript
 * import { MLLP_TLS_VERIFY_DISABLED, MLLP_BIND_ALL_INTERFACES } from '@cosyte/mllp';
 * client.on('securityWarning', (w) => {
 *   if (w.code === MLLP_TLS_VERIFY_DISABLED) logger.warn(w.message);
 * });
 * ```
 *
 * @packageDocumentation
 */

/**
 * Emitted (client-side) on every successful `secureConnect` — initial connect
 * AND every reconnect — when {@link TlsOptions.allowUnverified} is `true`.
 * Certificate verification is disabled for the connection; this is the loud,
 * per-connection reminder that the channel is not authenticated per IHE ATNA
 * ITI-19 (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html).
 *
 * @example
 * ```typescript
 * import { MLLP_TLS_VERIFY_DISABLED } from '@cosyte/mllp';
 * client.on('securityWarning', (w) => {
 *   if (w.code === MLLP_TLS_VERIFY_DISABLED) metrics.increment('mllp.tls_verify_disabled');
 * });
 * ```
 */
export const MLLP_TLS_VERIFY_DISABLED = "MLLP_TLS_VERIFY_DISABLED";

/**
 * Emitted (server-side) once at `listen()` time when the server binds a
 * wildcard host (`'0.0.0.0'` or `'::'`) with `ServerOptions.allowWildcardBind: true`.
 * Binding all interfaces widens the network exposure of the listener; this is
 * the loud, one-time reminder that the operator opted in.
 *
 * @example
 * ```typescript
 * import { MLLP_BIND_ALL_INTERFACES } from '@cosyte/mllp';
 * server.on('securityWarning', (w) => {
 *   if (w.code === MLLP_BIND_ALL_INTERFACES) logger.warn(w.message);
 * });
 * ```
 */
export const MLLP_BIND_ALL_INTERFACES = "MLLP_BIND_ALL_INTERFACES";

/**
 * Union of the two stable security-warning codes.
 *
 * @example
 * ```typescript
 * const code: SecurityWarningCode = 'MLLP_TLS_VERIFY_DISABLED';
 * ```
 */
export type SecurityWarningCode = typeof MLLP_TLS_VERIFY_DISABLED | typeof MLLP_BIND_ALL_INTERFACES;

/**
 * Frozen payload of the `'securityWarning'` event, emitted by both
 * {@link MllpClient} (`MLLP_TLS_VERIFY_DISABLED`) and {@link MllpServer}
 * (`MLLP_BIND_ALL_INTERFACES`).
 *
 * Never carries payload bytes or PHI — only routing metadata (host/port) and
 * a fixed, static message string.
 *
 * @example
 * ```typescript
 * client.on('securityWarning', (w: SecurityWarning) => {
 *   logger.warn({ code: w.code, host: w.host, port: w.port });
 * });
 * ```
 */
export interface SecurityWarning {
  /** The stable security-warning code. */
  readonly code: SecurityWarningCode;
  /** Fixed, human-readable description. Never contains payload bytes or PHI. */
  readonly message: string;
  /** Host associated with the warning (the target host for clients; the bind host for servers). */
  readonly host: string;
  /** Port associated with the warning. */
  readonly port: number;
  /** Wall-clock time at point of emission. */
  readonly timestamp: Date;
}
