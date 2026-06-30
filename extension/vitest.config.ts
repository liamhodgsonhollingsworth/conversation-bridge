import { defineConfig } from 'vitest/config';

// Unit tests cover only the PURE helpers in src/lib (no browser.* APIs).
// vitest transpiles with esbuild (no type-checking), so WXT's auto-imported
// `browser` global — referenced only inside functions the tests never call —
// does not need to be present.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
