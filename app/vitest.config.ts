import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'plugins/**/*.test.js', 'scripts/**/*.test.js'],
  },
  resolve: {
    alias: {
      'react-native-markdown-display': fileURLToPath(
        new URL('./src/test/react-native-markdown-display.tsx', import.meta.url),
      ),
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
});
