import cosyte from "@cosyte/eslint-config";

export default [
  ...cosyte(import.meta.dirname, {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "examples/**/*.ts", "*.config.ts"],
  }),

  // The examples are programs a reader runs: printing what they show is their job.
  {
    files: ["examples/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // no-buffer-slice, Buffer.prototype.slice() copies the underlying ArrayBuffer in modern Node;
  // use .subarray() for zero-copy. Scoped to the byte-handling paths (repo guardrail, stays an error).
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
            ".slice() copies the underlying ArrayBuffer in modern Node.js, .subarray() is zero-copy.",
        },
      ],
    },
  },
];
