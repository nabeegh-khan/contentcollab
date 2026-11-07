// Jest runs the TypeScript tests through ts-jest as ES modules, matching how
// tsx runs the server. Run with `npm test` (which sets --experimental-vm-modules).
/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { useESM: true }],
  },
  // Source imports end in .js (NodeNext); map them back to the .ts files
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  // Local defaults for DB_* and REDIS_*, the same values ci.yml sets
  setupFiles: ["<rootDir>/jest.env.js"],
};
