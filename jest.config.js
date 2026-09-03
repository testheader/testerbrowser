/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/__tests__/**/*.test.ts'],
  transform: {
    // Renderer modules are plain ESM .js, outside the build's rootDir. allowJs lets
    // tests import and type-infer the real code instead of a copy that can drift.
    '^.+\\.ts$': ['ts-jest', { tsconfig: { allowJs: true, rootDir: '.' } }],
    '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, rootDir: '.' } }],
  },
  moduleNameMapper: {
    '^electron$': '<rootDir>/src/__mocks__/electron.ts',
  },
};
