/**
 * The copy of the caller's TLS options a client or server takes at construction.
 *
 * @packageDocumentation
 */

import { MLLP_TLS_OPTIONS_NOT_AN_OBJECT, MllpTlsConfigurationError } from "./error.js";
import type { ServerTlsOptions, TlsOptions } from "./tls-options.js";

/** The name of an option a client's or a server's `tls` object can carry. */
type TlsOptionName = keyof TlsOptions | keyof ServerTlsOptions;

/**
 * Every option name either constructor reads, each mapped to itself. A `Record` over the union, so
 * the compiler refuses this list when an option is added to either interface and not here.
 */
const TLS_OPTION_NAMES: Readonly<Record<TlsOptionName, TlsOptionName>> = {
  ca: "ca",
  cert: "cert",
  key: "key",
  passphrase: "passphrase",
  pfx: "pfx",
  servername: "servername",
  minVersion: "minVersion",
  maxVersion: "maxVersion",
  atnaTransportSecurity: "atnaTransportSecurity",
  ciphers: "ciphers",
  allowUnverified: "allowUnverified",
  clientAuth: "clientAuth",
  dhParameters: "dhParameters",
};

/** A `Buffer` gets new bytes; anything else (a string, a number, a boolean) is kept as it is. */
function copyValue(value: unknown): unknown {
  return Buffer.isBuffer(value) ? Buffer.from(value) : value;
}

/**
 * Copy TLS options so that a change the caller makes to their object after construction never
 * reaches a socket.
 *
 * Both constructors check the options once (`pfx` with `cert` or `key` is refused there). A client
 * reads its TLS options again on every connect and reconnect, so had it kept the caller's object, a
 * `pfx` added to it later would reach the socket without passing that check. The copy is taken
 * before the check.
 *
 * Each known option is read once, by property access, so an option the caller supplies through a
 * getter or a prototype (a class instance, an `Object.create` object) is copied like an own field,
 * and an accessor cannot answer the check one way and the socket another. A name no option has is
 * not copied, since nothing reads it. An array (a `PemInput` list) is copied, and so are the bytes
 * of every `Buffer` (`cert`, `key`, `ca`, `pfx`, `dhParameters`): bytes the caller overwrites in
 * place after construction change neither the identity a client presents on reconnect nor what it
 * trusts.
 *
 * @param tls - The caller's TLS options, `true` for a client's defaults, or `undefined`.
 * @returns `true` and `undefined` as given; otherwise a new object with the options that are set.
 * @throws {MllpTlsConfigurationError} with {@link MLLP_TLS_OPTIONS_NOT_AN_OBJECT} when `tls` is
 *   `null` or any other value that is not an object.
 * @internal
 */
export function copyTlsOptions<T extends object | true | undefined>(tls: T): T {
  if (tls === undefined || tls === true) return tls;
  // Typed as an object, but a caller in JavaScript (or behind a cast) can pass anything.
  const given: unknown = tls;
  if (typeof given !== "object" || given === null) {
    throw new MllpTlsConfigurationError(MLLP_TLS_OPTIONS_NOT_AN_OBJECT);
  }
  const source = given as Readonly<Record<TlsOptionName, unknown>>;
  const copy: Partial<Record<TlsOptionName, unknown>> = {};
  for (const name of Object.values(TLS_OPTION_NAMES)) {
    const value = source[name];
    if (value === undefined) continue;
    copy[name] = Array.isArray(value) ? value.map(copyValue) : copyValue(value);
  }
  return copy as T;
}
