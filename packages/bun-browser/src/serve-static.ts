/**
 * serve-static.ts
 *
 * Generates a self-contained `Bun.serve` static-file-hosting script that runs
 * *inside* the WASM runtime (injected via `bun -e <script>`).
 *
 * The generated script:
 *   - Reads files from the VFS using `Bun.file(path).arrayBuffer()`
 *   - Infers Content-Type from common web file extensions
 *   - Falls back to `/index.html` for unknown paths (SPA mode)
 *   - Returns a 404 response if the fallback file is also missing
 *
 * Usage (host side, after building with `bun build`):
 *
 *   ```ts
 *   import { makeServeStaticScript } from './serve-static'
 *
 *   const script = makeServeStaticScript({ distDir: '/app/dist', port: 3000 })
 *   await wc.spawn('bun', ['-e', script])
 *   ```
 */

export interface ServeStaticOptions {
  /** Absolute VFS path of the directory to serve (e.g. "/app/dist"). */
  distDir: string
  /** Port for `Bun.serve`. Must be a fixed number; port:0 auto-assign is T5.14.4 (⏳). */
  port: number
  /**
   * Enable SPA fallback: serve `distDir/index.html` for any unknown path.
   * @default true
   */
  spaFallback?: boolean
  /**
   * Print a ready message to stdout after server starts.
   * @default true
   */
  logReady?: boolean
}

/**
 * Returns a script string for `bun -e <script>` that starts a static file
 * server inside the WASM runtime.
 */
export function makeServeStaticScript(opts: ServeStaticOptions): string {
  const { distDir, port, spaFallback = true, logReady = true } = opts

  // Language: plain JavaScript (no TypeScript — runs inside WASM bun-core)
  return `
(async () => {
  const DIST = ${JSON.stringify(distDir)};
  const MIME = {
    '.html':  'text/html; charset=utf-8',
    '.js':    'application/javascript; charset=utf-8',
    '.mjs':   'application/javascript; charset=utf-8',
    '.cjs':   'application/javascript; charset=utf-8',
    '.css':   'text/css; charset=utf-8',
    '.json':  'application/json; charset=utf-8',
    '.png':   'image/png',
    '.svg':   'image/svg+xml',
    '.ico':   'image/x-icon',
    '.wasm':  'application/wasm',
    '.txt':   'text/plain; charset=utf-8',
  };

  function mime(p) {
    const dot = p.lastIndexOf('.');
    if (dot === -1) return 'application/octet-stream';
    return MIME[p.slice(dot)] ?? 'application/octet-stream';
  }

  async function tryRead(absPath) {
    try {
      const data = await Bun.file(absPath).arrayBuffer();
      return new Response(data, { headers: { 'content-type': mime(absPath) } });
    } catch {
      return null;
    }
  }

  Bun.serve({
    port: ${JSON.stringify(port)},
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const absPath = DIST + pathname;

      const res = await tryRead(absPath);
      if (res) return res;

      ${spaFallback ? `
      // SPA fallback: return index.html for client-side routing
      const fallback = await tryRead(DIST + '/index.html');
      if (fallback) return fallback;
      ` : ''}

      return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    },
  });

  ${logReady ? `console.log('[serve-static] ready on port ' + ${JSON.stringify(port)});` : ''}
})();
`.trim()
}
