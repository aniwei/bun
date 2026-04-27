import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: packageRoot,
  resolve: {
    alias: {
      '@mars/web-net': resolve(packageRoot, '../bun-web-net/src/index.ts'),
      harness: resolve(packageRoot, '../../test/harness.ts'),
      'node-harness': resolve(packageRoot, '../../test/js/node/harness.ts'),
      'deno:harness': resolve(packageRoot, '../../test/js/deno/harness.ts'),
      '_util': resolve(packageRoot, '../../test/_util'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    passWithNoTests: false,
    isolate: true,
  },
})
