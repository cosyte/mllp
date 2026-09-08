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
 * a PKCS#3 `DH PARAMETERS` PEM block whose body decodes to a DER `SEQUENCE`
 * beginning with two `INTEGER`s, which is what the TLS library will look for.
 * It does **not** establish that the group is sound: neither that the prime is
 * prime nor that the generator generates. The check that would
 * (`crypto.createDiffieHellman(prime, generator).verifyError`) runs a full
 * primality test, measured at 1.8 s for a 3072-bit group and 30 s for an
 * 8192-bit one on this container, and `listen()` is not a place to spend that.
 * A structurally sound block carrying a composite prime, or a generator the
 * library will not accept, is therefore accepted here and fails at handshake
 * time. Said plainly rather than left to be inferred from a promise this module
 * does not keep.
 *
 * WHY THE ARMOUR IS READ LINE BY LINE. The encapsulation boundary is the one
 * place where "looks like a PEM block" and "is a PEM block the library reads"
 * come apart, and the gap is reachable by accident rather than by typing
 * garbage: a value that crosses an environment variable or a single-line JSON
 * field arrives with its newlines collapsed, and it is still a boundary, a
 * body and a boundary in the right order. The library requires each boundary to
 * occupy a line of its own with exactly five dashes on each side, so that
 * collapsed value is not parameters at all and is discarded in silence. This
 * reader therefore mirrors what the library's own PEM reader does with a line
 * rather than searching the text for a boundary-shaped substring.
 *
 * The bytes are read as an opaque parameter block: nothing derived from them
 * reaches a message, an error, or a log line.
 *
 * @packageDocumentation
 */

/**
 * The encapsulation boundaries of a PKCS#3 parameter block, exactly as the TLS
 * library's PEM reader requires them: five dashes, the keyword, the label, five
 * dashes, alone on a line.
 */
const BEGIN_BOUNDARY = "-----BEGIN DH PARAMETERS-----";
const END_BOUNDARY = "-----END DH PARAMETERS-----";

/**
 * The byte-order mark, in both spellings this module can meet: the decoded
 * character when the caller passed a string, and the same three bytes seen
 * through the latin1 decode when the caller passed a buffer. The library's PEM
 * reader strips it from the first line, so it cannot be what refuses a block.
 */
const BOM_SPELLINGS: readonly string[] = [
  String.fromCharCode(0xfeff),
  String.fromCharCode(0xef, 0xbb, 0xbf),
];

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
 * One line as the TLS library's PEM reader sees it: every trailing character at
 * or below `U+0020` removed.
 *
 * That single rule is why a file written with CRLF endings, a boundary followed
 * by stray spaces, and the canonical block all read identically. It deliberately
 * does **not** touch LEADING whitespace, because the library does not either: an
 * indented boundary is not a boundary, and a server built on one runs with no
 * parameters.
 *
 * @param line - One line of the input, split on line feeds.
 * @returns The line with its trailing blanks removed.
 */
function sanitizeLine(line: string): string {
  let end = line.length;
  while (end > 0 && line.charCodeAt(end - 1) <= 0x20) end -= 1;
  return line.slice(0, end);
}

/**
 * The base64 body of the `DH PARAMETERS` block in `text`, or `null` when the
 * armour is not armour the TLS library reads.
 *
 * WHAT COUNTS AS A BOUNDARY, AND WHY IT IS THIS STRICT. The library reads PEM a
 * line at a time and requires an encapsulation boundary to be the whole line:
 * exactly five dashes, the keyword, the label, exactly five dashes. Measured on
 * this container, every one of these advertises a DHE suite and then answers no
 * handshake, because the library found no parameters and discarded them without
 * a word: the same block with its newlines collapsed, with an extra dash on
 * either boundary, with either boundary indented by a space or a tab, with the
 * body sharing a line with a boundary, and with a boundary preceded by anything
 * else on its line. Matching a boundary-shaped substring anywhere in the text
 * accepts all of them.
 *
 * WHAT IT STILL ADMITS, BECAUSE THE LIBRARY DOES. Text before the opening
 * boundary and after the closing one, a byte-order mark, CRLF endings, a missing
 * final newline, trailing blanks on any line, leading blanks on a BODY line, and
 * a body wrapped at any width or not wrapped at all. Refusing one of those would
 * be this same defect pointed the other way: a configuration the runtime accepts
 * turned into a listener that will not start.
 *
 * A blank line between the boundaries opens the encapsulated header section, and
 * the library refuses every header this option could not answer anyway, so a
 * blank line is admitted only where the header it opens is empty.
 *
 * @param text - The caller's input, decoded to text.
 * @returns The body with all whitespace removed, or `null`.
 */
function readArmouredBody(text: string): string | null {
  let head = text;
  for (const bom of BOM_SPELLINGS) {
    if (head.startsWith(bom)) {
      head = head.slice(bom.length);
      break;
    }
  }

  // A line feed is the only line ending the reader knows; a lone carriage
  // return is an ordinary character, so a file that uses one is not lines.
  const lines = head.split("\n").map(sanitizeLine);
  const begin = lines.indexOf(BEGIN_BOUNDARY);
  if (begin === -1) return null;
  const end = lines.indexOf(END_BOUNDARY, begin + 1);
  if (end === -1) return null;

  const inner = lines.slice(begin + 1, end);
  const blank = inner.indexOf("");
  if (blank !== -1) {
    // Everything before the first blank line is a header, and this option takes
    // no passphrase, so there is no header it could honour.
    if (blank !== 0) return null;
    // A second blank line would truncate the body the same way.
    if (inner.indexOf("", 1) !== -1) return null;
  }

  const body = inner.join("").replace(/\s+/g, "");
  return body.length === 0 ? null : body;
}

/**
 * Whether `input` is a PKCS#3 Diffie-Hellman parameter block this package will
 * hand to a TLS context.
 *
 * The four refusals it exists for, in the order a caller hits them: content
 * that is not PEM at all, a PEM block of some other kind (a certificate, a key),
 * a `DH PARAMETERS` block whose encapsulation boundaries are not the ones the
 * TLS library reads a line at a time, and one whose body is not the
 * `INTEGER`-then-`INTEGER` `SEQUENCE` it expects. Each of those is discarded in
 * silence by the library itself, which is why they are caught here instead.
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
  const body = readArmouredBody(text);
  if (body === null) return false;

  // Checked BEFORE decoding: `Buffer.from(s, 'base64')` never throws and skips
  // whatever it cannot read, so a body that is not base64 at all decodes to a
  // shorter buffer that could still parse. The regexp is what refuses it.
  if (body.length % 4 !== 0 || !BASE64_BODY.test(body)) return false;

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
