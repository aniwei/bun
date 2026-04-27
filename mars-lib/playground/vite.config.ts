const workspaceRoot = new URL("..", import.meta.url).pathname

export default {
  server: {
    fs: {
      allow: [workspaceRoot],
    },
  },
  resolve: {
    alias: {
      "@mars/bridge": `${workspaceRoot}/packages/mars-bridge/src/index.ts`,
      "@mars/vfs": `${workspaceRoot}/packages/mars-vfs/src/index.ts`,
      "@mars/kernel": `${workspaceRoot}/packages/mars-kernel/src/index.ts`,
      "@mars/sw": `${workspaceRoot}/packages/mars-sw/src/index.ts`,
      "@mars/shared": `${workspaceRoot}/packages/mars-shared/src/index.ts`,
      "@mars/runtime": `${workspaceRoot}/packages/mars-runtime/src/index.ts`,
      "@mars/resolver": `${workspaceRoot}/packages/mars-resolver/src/index.ts`,
      "@mars/transpiler": `${workspaceRoot}/packages/mars-transpiler/src/index.ts`,
      "@mars/loader": `${workspaceRoot}/packages/mars-loader/src/index.ts`,
      "@mars/installer": `${workspaceRoot}/packages/mars-installer/src/index.ts`,
      "@mars/bundler": `${workspaceRoot}/packages/mars-bundler/src/index.ts`,
      "@mars/node": `${workspaceRoot}/packages/mars-node/src/index.ts`,
      "@mars/shell": `${workspaceRoot}/packages/mars-shell/src/index.ts`,
      "@mars/client": `${workspaceRoot}/packages/mars-client/src/index.ts`,
    },
  },
}
