/**
 * A module whose exports are TLS options, so a test can pass its namespace object
 * (`import * as tlsOptions from ...`) as `tls`. A namespace's built-in tag is `Module`, not
 * `Object`, and a caller can hold TLS settings this way. The certificate is generated in memory
 * when the module loads; no file and no real identity is involved.
 */

import { buildServerCertFixture } from "./tls-fixtures.js";

const fixture = buildServerCertFixture();

/** The server's certificate PEM, self-signed for `localhost` and `127.0.0.1`. */
export const cert = fixture.cert;

/** The server's private key PEM. */
export const key = fixture.key;

/** The same certificate as a trust anchor, so a client given this namespace trusts the server. */
export const ca = fixture.cert;
