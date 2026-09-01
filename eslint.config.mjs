import js from '@eslint/js';
import globals from 'globals';

export default [
  // renderer.js is the legacy monolithic file, superseded by the module split and no longer loaded.
  { ignores: ['renderer/renderer.js'] },
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
