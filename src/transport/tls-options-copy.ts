/**
 * The copy of the caller's TLS options a client or server takes at construction.
 *
 * @packageDocumentation
 */

/**
 * Copy TLS options so that a change the caller makes to their object after construction never
 * reaches a socket.
 *
 * Both constructors check the options once (`pfx` with `cert` or `key` is refused there). A client
 * reads its TLS options again on every connect and reconnect, so had it kept the caller's object, a
 * `pfx` added to it later would reach the socket without passing that check. The copy is taken
 * before the check, and each option is read exactly once, so an accessor cannot answer the check
 * one way and the socket another. An array value (a `PemInput` list) is copied too; a `Buffer` is
 * kept as it is, since its bytes are loaded again (and checked again) on every client connect.
 *
 * @param tls - The caller's TLS options, `true` for a client's defaults, or `undefined`.
 * @returns `true` and `undefined` as given; otherwise a new object with the same options.
 * @internal
 */
export function copyTlsOptions<T extends object | true | undefined>(tls: T): T {
  if (typeof tls !== "object") return tls;
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(tls)) {
    copy[name] = Array.isArray(value) ? [...(value as unknown[])] : value;
  }
  return copy as T;
}
