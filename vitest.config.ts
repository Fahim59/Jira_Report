import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts (whose root is web/) so tests are discovered from the project root.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
