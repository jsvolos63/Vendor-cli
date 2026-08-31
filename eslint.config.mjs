// ESLint flat config. Goal: catch shadows / unused vars / undefined
// references going forward without forcing a sweeping style cleanup — CI
// should flag real bugs, not stylistic preferences.
//
// This is the highest-leverage code in the family and the last of it to get a
// linter: every vendored copy in every consumer repo is this package's OUTPUT,
// and the generator's worst historical failure mode is exit 0 plus a plausible
// file plus a ReferenceError at load in the consumer. `vendor:check` cannot
// see that class of bug, because regeneration repeats it.
//
// Everything here is Node ESM. index.mjs resolves esbuild lazily so the
// stamper and bumper bins never load it — a top-level import would be a
// regression, not a style question.
import js from '@eslint/js';
import globals from 'globals';

const rules = {
  'no-shadow': 'error',
  'no-unused-vars': ['error', {
    args: 'after-used',
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_?$',
  }],
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-useless-escape': 'off',
  'prefer-const': 'off',
  // OFF, deliberately: the generator's lexer and the sanitizer-policy
  // machinery both match control characters and known multi-space indents in
  // emitted output; the rules fire on the subject matter, not on mistakes.
  'no-control-regex': 'off',
  'no-regex-spaces': 'off',
};

export default [
  js.configs.recommended,
  {
    files: ['index.mjs', 'bin/**/*.mjs', 'module-graph/**/*.mjs', 'test/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules,
  },
  {
    // Fixture kits are inputs to the generator, not source: they are
    // deliberately odd (a top-level `$`, semicolon-less declarations, policy
    // marker regions) precisely so the generator's refusals can be tested.
    ignores: ['node_modules/**', 'test/fixture-kit/**'],
  },
];
