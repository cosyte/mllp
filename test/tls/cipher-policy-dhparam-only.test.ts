/**
 * A server that names its own Diffie-Hellman group and leaves the cipher list alone gets exactly
 * that group back, and no cipher list: the runtime default suites stay in force.
 */

import { describe, expect, it } from "vitest";

import { resolveTlsCipherPolicy } from "../../src/index.js";
import { DH_PARAMETERS_3072_PEM } from "../helpers/dhparam-fixtures.js";

describe("resolveTlsCipherPolicy: Diffie-Hellman parameters without a cipher list", () => {
  it("returns the caller's group and no ciphers on the server side", () => {
    const policy = resolveTlsCipherPolicy({ dhParameters: DH_PARAMETERS_3072_PEM }, "server");
    expect(policy).toEqual({ dhparam: DH_PARAMETERS_3072_PEM });
    expect("ciphers" in policy).toBe(false);
  });

  it("ignores the group on the client side, where the option does not apply", () => {
    expect(resolveTlsCipherPolicy({ dhParameters: DH_PARAMETERS_3072_PEM }, "client")).toEqual({});
  });
});
