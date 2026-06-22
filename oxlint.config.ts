import { defineConfig } from 'oxlint';

// CLI Node — only restrict globals that shadow safer Number.* equivalents.
// Browser-centric globals (window/screen/history/…) are excluded.
const deniedGlobals = [
  'isFinite',
  'isNaN',
];

export default defineConfig({
  plugins: ['import', 'typescript', 'unicorn'],
  categories: {
    correctness: 'error',
    suspicious: 'warn',
    perf: 'warn',
  },
  env: {
    builtin: true,
    node: true,
  },
  globals: {
    Bun: 'readonly',
    vi: 'readonly',
    expect: 'readonly',
    test: 'readonly',
    it: 'readonly',
    describe: 'readonly',
    beforeEach: 'readonly',
    afterEach: 'readonly',
    beforeAll: 'readonly',
    afterAll: 'readonly',
  },
  rules: {
    'eslint/no-unused-vars': ['error', {
      destructuredArrayIgnorePattern: '^_',
      ignoreRestSiblings: true,
      argsIgnorePattern: '^_',
    }],
    'eslint/no-restricted-globals': ['error', ...deniedGlobals],
    // CLI prints to stdout — log is intentionally blocked at root level.
    // An override for packages/cli/** will allow 'log' once that package exists.
    'eslint/no-console': ['error', { allow: ['assert', 'error', 'info', 'warn', 'debug'] }],
    'eslint/no-debugger': 'error',
    'eslint/no-empty': 'error',
    'eslint/no-var': 'error',
    'eslint/prefer-const': 'error',
    'eslint/eqeqeq': ['error', 'always'],

    'typescript/no-explicit-any': 'error',
    'typescript/no-non-null-assertion': 'warn',
    'typescript/no-namespace': 'error',

    'import/namespace': 'error',
    'import/default': 'error',
    'import/no-duplicates': 'warn',
    'import/no-named-as-default': 'warn',
    'import/no-named-as-default-member': 'warn',

    'typescript/no-extraneous-class': 'off',

    'eslint/no-await-in-loop': 'off',
    'eslint/no-underscore-dangle': 'off',
    'eslint/no-shadow': ['warn', { allow: [] }],
    'eslint/preserve-caught-error': 'warn',
    'eslint/no-unused-expressions': 'warn',
    // On ne lance/rejette que des objets Error.
    'eslint/no-throw-literal': 'error',

    'unicorn/no-array-sort': 'off',
    'unicorn/consistent-function-scoping': 'warn',
    'unicorn/no-new-array': 'warn',
    'unicorn/no-negated-condition': 'error',
    // préférer .at(-i) à [arr.length - i]
    'unicorn/prefer-at': 'warn',
    // pas d'objet littéral en valeur par défaut de paramètre
    'unicorn/no-object-as-default-parameter': 'warn',

    'import/no-unassigned-import': 'off',

    'unicorn/no-array-reduce': 'off',
    'unicorn/prefer-array-some': 'error',
    'unicorn/no-useless-undefined': 'off',

    'import/no-default-export': 'off',
  },
  ignorePatterns: [
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/*.d.ts',
  ],
  overrides: [
    {
      files: [
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/*.spec.js',
        '**/*.test.js',
        '**/tests/**',
        '**/__mocks__/**',
      ],
      rules: {
        'typescript/no-explicit-any': 'off',
        'typescript/no-non-null-assertion': 'off',
        'eslint/no-use-before-define': 'off',
        'eslint/no-shadow': 'off',
        'eslint/no-unused-expressions': 'off',
      },
    },
  ],
});
