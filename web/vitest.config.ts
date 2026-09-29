import { defineConfig } from 'vitest/config';

// Só lógica pura (fila, backoff, erros, mock) — ambiente node, sem DOM.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
