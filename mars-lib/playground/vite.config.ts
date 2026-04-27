const workspaceRoot = new URL("..", import.meta.url).pathname
const serviceWorkerScopeSmokeScriptURL = "/mars-sw-scope-smoke.js"

const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
}

interface MarsViteDevServer {
  middlewares: {
    use(listener: MarsViteMiddleware): void
  }
}

type MarsViteMiddleware = (
  request: { url?: string },
  response: {
    statusCode: number
    setHeader(name: string, value: string): void
    end(body: string): void
  },
  next: () => void,
) => void

export default {
  define: {
    __MARS_WORKSPACE_ROOT__: JSON.stringify(workspaceRoot),
  },
  plugins: [
    {
      name: "mars-service-worker-scope-smoke",
      configureServer(server: MarsViteDevServer) {
        installCrossOriginIsolationMiddleware(server)
        installServiceWorkerScopeSmokeMiddleware(server)
      },
      configurePreviewServer(server: MarsViteDevServer) {
        installCrossOriginIsolationMiddleware(server)
        installServiceWorkerScopeSmokeMiddleware(server)
      },
    },
  ],
  server: {
    headers: crossOriginIsolationHeaders,
    fs: {
      allow: [workspaceRoot],
    },
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  resolve: {
    alias: {
      "@mars/bridge": `${workspaceRoot}/packages/mars-bridge/src/index.ts`,
      "@mars/vfs": `${workspaceRoot}/packages/mars-vfs/src/index.ts`,
      "@mars/kernel": `${workspaceRoot}/packages/mars-kernel/src/index.ts`,
      "@mars/crypto": `${workspaceRoot}/packages/mars-crypto/src/index.ts`,
      "@mars/sqlite": `${workspaceRoot}/packages/mars-sqlite/src/index.ts`,
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

function installCrossOriginIsolationMiddleware(server: MarsViteDevServer): void {
  server.middlewares.use((_request, response, next) => {
    for (const [name, value] of Object.entries(crossOriginIsolationHeaders)) {
      response.setHeader(name, value)
    }
    next()
  })
}

function installServiceWorkerScopeSmokeMiddleware(server: MarsViteDevServer): void {
  server.middlewares.use((request, response, next) => {
    if (!request.url?.startsWith(serviceWorkerScopeSmokeScriptURL)) {
      next()
      return
    }

    response.statusCode = 200
    response.setHeader("content-type", "text/javascript; charset=utf-8")
    response.setHeader("service-worker-allowed", "/")
    response.end(createServiceWorkerScopeSmokeScript())
  })
}

function createServiceWorkerScopeSmokeScript(): string {
  return [
    `import { createMarsVFS } from ${JSON.stringify(marsPackageImportURL("mars-vfs"))}`,
    `import { restoreVFSSnapshot } from ${JSON.stringify(marsPackageImportURL("mars-vfs"))}`,
    `import { createMarsKernel } from ${JSON.stringify(marsPackageImportURL("mars-kernel"))}`,
    `import { createServiceWorkerRouter, installServiceWorkerBootstrap } from ${JSON.stringify(marsPackageImportURL("mars-sw"))}`,
    "",
    "self.addEventListener('install', event => {",
    "  event.waitUntil(bootPromise.then(() => self.skipWaiting()))",
    "})",
    "self.addEventListener('activate', event => {",
    "  event.waitUntil(bootPromise.then(() => self.clients.claim()))",
    "})",
    "",
    "const vfs = createMarsVFS({ cwd: '/workspace' })",
    "const initialSnapshot = {",
    "  src: {",
    "    kind: 'directory',",
    "    children: {",
    "      'sw-scope-entry.ts': {",
    "        kind: 'file',",
    "        encoding: 'base64',",
    "        data: btoa([",
    "          \"import { message } from './sw-scope-message'\",",
    "          \"export const serviceWorkerScopeSmokeEntry = `scope:${message}`\",",
    "        ].join('\\n')),",
    "      },",
    "      'sw-scope-message.ts': {",
    "        kind: 'file',",
    "        encoding: 'base64',",
    "        data: btoa(\"export const message = 'real service worker scope smoke'\"),",
    "      },",
    "    },",
    "  },",
    "}",
    "const kernel = createMarsKernel()",
    "const router = createServiceWorkerRouter({",
    "  kernelClient: {",
    "    resolvePort: async () => null,",
    "    dispatchToKernel: async () => new Response('Kernel route not configured', { status: 404 }),",
    "  },",
    "  vfsClient: {",
    "    readFile: async path => {",
    "      if (!vfs.existsSync(path)) return null",
    "      const data = await vfs.readFile(path)",
    "      return typeof data === 'string' ? new TextEncoder().encode(data) : data",
    "    },",
    "    stat: async path => vfs.existsSync(path) ? vfs.stat(path) : null,",
    "    contentType: () => 'text/plain; charset=utf-8',",
    "  },",
    "  moduleClient: { vfs },",
    "  fallback: 'network',",
    "})",
    "const bootPromise = restoreVFSSnapshot(vfs, initialSnapshot, '/workspace')",
    "",
    "installServiceWorkerBootstrap({ scope: self, router, ready: bootPromise })",
    "",
  ].join("\n")
}

function marsPackageImportURL(packageName: "mars-vfs" | "mars-kernel" | "mars-sw"): string {
  return `/@fs${workspaceRoot}packages/${packageName}/src/index.ts`
}
