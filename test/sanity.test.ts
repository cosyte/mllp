import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("sanity", () => {
  it("package exports VERSION matching package.json", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("Node.js version is 22+", () => {
    const major = parseInt(process.version.slice(1).split(".")[0] ?? "0", 10);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
