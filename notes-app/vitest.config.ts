import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic in `src/lib` — no React, no renderer, no device.
 *
 * Scope is deliberately narrow. Anything that imports `expo-sqlite`,
 * `expo-file-system` or a native module can't run here (those are native
 * modules with no Node implementation), and component tests would need a
 * renderer. This config covers the layer that needs neither.
 *
 * `react-native` is aliased to a small stub because a couple of modules read
 * `Platform.OS` at import time; see test/stubs/react-native.ts.
 */
const resolve = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve('./src'),
      'react-native': resolve('./test/stubs/react-native.ts'),
    },
  },
});
