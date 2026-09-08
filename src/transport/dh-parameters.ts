/**
 * Structural reading of caller-supplied ephemeral Diffie-Hellman parameters.
 *
 * WHY THIS EXISTS RATHER THAN A BARE PASSTHROUGH. The TLS library **silently
 * discards** parameters it cannot read: measured on Node v24.20.0,
 * `tls.createSecureContext({ dhparam: 'not a pem at all' })` returns a context
 * with no error at all, and a server built on it advertises its DHE suites and
 * then fails every DHE handshake in them. A server that answers no handshake is
 * the failure mode this package refuses to arrive at silently, so what a caller
 * hands over is read here first, before any socket is bound.
 *
 * WHAT THIS READ DOES AND DOES NOT ESTABLISH. It establishes that the input is
 * a PKCS#3 `DH PARAMETERS` PEM block whose body decodes to a DER `SEQUENCE` of
 * two `INTEGER`s and nothing else, which is what the TLS library will look for.
 * It does **not** establish that the prime is prime: the check that would
 * (`crypto.createDiffieHellman(prime, generator).verifyError`) runs a full
 * primality test, measured at 1.8 s for a 3072-bit group and 30 s for an
 * 8192-bit one on this container, and `listen()` is not a place to spend that.
 * A structurally sound group with a composite prime is therefore accepted here
 * and refused by the peer at handshake time. Said plainly rather than left to
 * be inferred from a promise this module does not keep.
 *
 * The bytes are read as an opaque parameter block: nothing derived from them
 * reaches a message, an error, or a log line.
 *
 * @packageDocumentation
 */

/** PEM armour for the PKCS#3 parameter block `tls.createServer`'s `dhparam` reads. */
const DH_PEM_BLOCK = /-----BEGIN DH PARAMETERS-----([\sA-Za-z0-9+/=]*?)-----END DH PARAMETERS-----/;

/** A base64 body: full quartets, padding only at the end. */
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

/** ASN.1 DER tag numbers this reader accepts, and no others. */
const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;

/** One definite-length DER element: its tag, and where its contents begin and end. */
interface DerElement {
  readonly tag: number;
  readonly contentStart: number;
  readonly contentEnd: number;
}

/**
 * Read one definite-length DER element starting at `offset`.
 *
 * Returns `null` for a truncated element, for the indefinite-length form (`0x80`,
 * which is BER and not DER), and for a length field wider than this reader will
 * follow. Refusing is always the safe answer here: the caller treats `null` as
 * "these are not parameters this package will hand to a TLS context".
 *
 * @param der - The decoded DER bytes.
 * @param offset - Index of the element's tag byte.
 * @returns The element's tag and content bounds, or `null` when it does not parse.
 */
function readDerElement(der: Buffer, offset: number): DerElement | null {
  if (offset + 2 > der.length) return null;
  const tag = der[offset];
  const first = der[offset + 1];
  if (tag === undefined || first === undefined) return null;

  let contentStart: number;
  let length: number;
  if (first < 0x80) {
    contentStart = offset + 2;
    length = first;
  } else {
    const lengthBytes = first & 0x7f;
    // 0x80 is the indefinite-length form (BER, never DER); a length field wider
    // than four bytes describes contents no PEM block here could carry.
    if (lengthBytes === 0 || lengthBytes > 4) return null;
    if (offset + 2 + lengthBytes > der.length) return null;
    length = 0;
    for (let i = 0; i < lengthBytes; i += 1) {
      const byte = der[offset + 2 + i];
      if (byte === undefined) return null;
      length = length * 256 + byte;
    }
    contentStart = offset + 2 + lengthBytes;
  }

  const contentEnd = contentStart + length;
  if (contentEnd > der.length) return null;
  return { tag, contentStart, contentEnd };
}

/**
 * Whether `input` is a PKCS#3 Diffie-Hellman parameter block this package will
 * hand to a TLS context.
 *
 * The three refusals it exists for, in the order a caller hits them: content
 * that is not PEM at all, a PEM block of some other kind (a certificate, a key),
 * and a `DH PARAMETERS` block whose body is not the two-`INTEGER` `SEQUENCE`
 * the TLS library reads. Each of those is discarded in silence by the library
 * itself, which is why they are caught here instead.
 *
 * `'auto'` is deliberately **not** accepted: the automatic selection is reached
 * through `ServerTlsOptions.atnaTransportSecurity`, and a magic string on a
 * field documented as PEM content would be a second, undocumented spelling of
 * it.
 *
 * @param input - Candidate PEM content, as a string or as raw bytes.
 * @returns `true` when the block parses as PKCS#3 DH parameters.
 *
 * @example
 * ```typescript
 * isDhParametersPem("-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----\n");
 * // => false
 * ```
 */
export function isDhParametersPem(input: string | Buffer): boolean {
  // PEM armour is ASCII, so latin1 round-trips any byte without substituting
  // U+FFFD the way a utf8 decode of arbitrary bytes would.
  const text = typeof input === "string" ? input : input.toString("latin1");
  const block = DH_PEM_BLOCK.exec(text);
  if (block === null) return false;

  const body = (block[1] ?? "").replace(/\s+/g, "");
  // Checked BEFORE decoding: `Buffer.from(s, 'base64')` never throws and skips
  // whatever it cannot read, so a body that is not base64 at all decodes to a
  // shorter buffer that could still parse. The regexp is what refuses it.
  if (body.length === 0 || body.length % 4 !== 0 || !BASE64_BODY.test(body)) return false;

  const der = Buffer.from(body, "base64");
  const sequence = readDerElement(der, 0);
  if (sequence === null || sequence.tag !== DER_SEQUENCE) return false;
  // Trailing bytes after the SEQUENCE mean the block is not what it claims.
  if (sequence.contentEnd !== der.length) return false;

  const prime = readDerElement(der, sequence.contentStart);
  if (prime === null || prime.tag !== DER_INTEGER) return false;
  const generator = readDerElement(der, prime.contentEnd);
  if (generator === null || generator.tag !== DER_INTEGER) return false;
  return generator.contentEnd <= sequence.contentEnd;
}
