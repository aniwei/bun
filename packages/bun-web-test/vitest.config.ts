import { defineConfig } from 'vitest/config'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: packageRoot,
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    passWithNoTests: false,
    isolate: true,
  },
})
