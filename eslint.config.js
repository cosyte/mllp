import cosyte from "@cosyte/eslint-config";

export default [
  ...cosyte(import.meta.dirname, {
    ignores: ["examples/**", "bench/**"],
  }),

  // SETUP-07: no-buffer-slice — Buffer.prototype.slice() copies in modern Node; use .subarray()
  // for zero-copy. Scoped to the byte-handling paths.
  {
    files: ["src/framing/**/*.ts", "src/server/**/*.ts", "src/client/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='slice'][callee.object.type!='ArrayExpression']",
          message:
            "Use Buffer.prototype.subarray() instead of .slice() in src/framing|server|client. " +
            ".slice() copies the underlying ArrayBuffer in modern Node.js — .subarray() is zero-copy. " +
            "(SETUP-07)",
        },
      ],
    },
  },

  // D-02: @types/node gaps (socket.read() → Buffer | null typed as any) — warn, not error, only in
  // the transport/connection code that directly touches net.Socket events.
  {
    files: ["src/transport/**/*.ts", "src/connection/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
    },
  },

  // TODO(docs): mllp is mid-build (Phase 5) and not yet JSDoc-complete on every public export.
  // The cosyte standard requires JSDoc + @example on public exports (error); relax to `warn` here
  // until the docs are authored, then delete this block. Tracked as a foundation follow-up.
  {
    files: ["src/**/*.ts"],
    rules: {
      "jsdoc/require-jsdoc": "warn",
      "jsdoc/require-example": "warn",
    },
  },
];
