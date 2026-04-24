// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/** @type {import('typescript-eslint').Config} */
export default tseslint.config(
  // Base recommended rules for all TS files
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked, // D-01: recommended-type-checked

  // Parser options for type-aware rules (D-01: projectService:true)
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // SETUP-07: no-buffer-slice custom rule — error, scoped to src/framing, src/server, src/client
  // Buffer.prototype.slice() copies in modern Node; use .subarray() for zero-copy.
  {
    files: ['src/framing/**/*.ts', 'src/server/**/*.ts', 'src/client/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='slice'][callee.object.type!='ArrayExpression']",
          message:
            'Use Buffer.prototype.subarray() instead of .slice() in src/framing|server|client. ' +
            '.slice() copies the underlying ArrayBuffer in modern Node.js — .subarray() is zero-copy. ' +
            '(SETUP-07)',
        },
      ],
    },
  },

  // D-02: targeted override for @types/node gaps (socket.read() → Buffer | null typed as any)
  // Applies only to transport/connection code that directly touches net.Socket events.
  {
    files: ['src/transport/**/*.ts', 'src/connection/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
    },
  },

  // Ignore patterns
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'examples/**', 'bench/**', '*.config.*'],
  },
);
