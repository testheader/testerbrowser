import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    files: ['renderer/*.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        testerBrowser: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
      'prefer-const': 'error',
      'eqeqeq': 'error',
    },
  },
];
