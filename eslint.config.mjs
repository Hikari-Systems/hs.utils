import js from '@eslint/js';
import prettier from 'eslint-plugin-prettier';
import typescriptEslint from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import _import from 'eslint-plugin-import';
import globals from 'globals';

export default [
  // Global ignores
  {
    ignores: ['es5/', 'static/'],
  },
  // Base recommended config
  js.configs.recommended,
  // Global config for all files
  {
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    plugins: {
      import: _import,
      prettier,
    },
    rules: {
      // Prettier integration
      'prettier/prettier': ['error'],
      // Import rules
      'import/extensions': 'off',
      'import/prefer-default-export': 'off',
      'import/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: ['**/*.test.ts', '**/*.spec.ts'],
        },
      ],
      // Best practices (airbnb-style)
      'no-underscore-dangle': ['warn', { allowAfterThis: true }],
      'no-await-in-loop': 'warn',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ForInStatement',
          message:
            'for..in loops iterate over the entire prototype chain, which is virtually never what you want. Use Object.{keys,values,entries}, and iterate over the resulting array.',
        },
        {
          selector: 'ForOfStatement',
          message:
            'iterators/generators require regenerator-runtime, which is too heavyweight for this guide to allow. However, you can use forEach instead.',
        },
      ],
      'class-methods-use-this': 'warn',
      'no-continue': 'off',
      camelcase: 'off',
    },
  },
  // TypeScript-specific config
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
    },
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts'],
      },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
    rules: {
      ...typescriptEslint.configs.recommended.rules,
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
];
