import { BunContainer, PreviewManager, type BunContainerBootOptions, type FileTree } from '@mars/web-client'

export interface BunWebExampleOptions {
  boot?: BunContainerBootOptions
  container?: BunContainer
  useCase?: BunWebExampleUseCase
  entrypoint?: string
  files?: FileTree
  message?: string
}

export type BunWebExampleUseCase =
  | 'vite-react-ts'
  | 'express'
  | 'koa'
  | 'fastify'
  | 'hono'
  | 'bun-serve-routes'

export interface BunWebExampleScenario {
  id: BunWebExampleUseCase
  title: string
  description: string
  defaultEntrypoint: string
  createFiles(message: string): FileTree
}

export interface BunWebExampleResult {
  container: BunContainer
  useCase: BunWebExampleUseCase
  entrypoint: string
  exitCode: number
  output: string
  previewManager: PreviewManager
  previewURL: string | null
}

const APP_STYLE = `:root {
  font-family: 'Inter', 'SF Pro Text', 'Segoe UI', sans-serif;
  line-height: 1.5;
  color: #0f172a;
  background: radial-gradient(circle at 20% -10%, #dbeafe 0%, transparent 38%),
    radial-gradient(circle at 80% 0%, #e0e7ff 0%, transparent 42%),
    #f8fafc;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
}

#root {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 28px;
}

.dify-shell {
  width: min(980px, 100%);
  border-radius: 24px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(12px);
  box-shadow: 0 28px 60px rgba(15, 23, 42, 0.16);
  border: 1px solid rgba(148, 163, 184, 0.26);
}

.dify-header {
  padding: 18px 22px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.dify-brand {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #334155;
}

.dify-status {
  font-size: 12px;
  color: #475569;
  background: #ecfeff;
  border: 1px solid #bae6fd;
  border-radius: 999px;
  padding: 4px 10px;
}

.dify-main {
  display: grid;
  grid-template-columns: 220px 1fr;
}

.dify-side {
  border-right: 1px solid rgba(148, 163, 184, 0.2);
  padding: 16px;
  background: linear-gradient(180deg, #f8fafc, #f1f5f9);
}

.dify-side-item {
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  color: #475569;
}

.dify-side-item.active {
  background: #dbeafe;
  color: #1d4ed8;
  font-weight: 600;
}

.dify-content {
  padding: 24px;
}

.dify-title {
  margin: 0;
  font-size: 30px;
  line-height: 1.2;
  color: #0f172a;
}

.dify-subtitle {
  margin-top: 10px;
  color: #334155;
}

.dify-card {
  margin-top: 20px;
  border-radius: 14px;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: #fff;
  padding: 16px;
}

.dify-card-title {
  margin: 0;
  font-size: 14px;
  color: #334155;
}

.dify-card-body {
  margin-top: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  color: #0f172a;
  white-space: pre-wrap;
}

@media (max-width: 760px) {
  .dify-main {
    grid-template-columns: 1fr;
  }

  .dify-side {
    border-right: none;
    border-bottom: 1px solid rgba(148, 163, 184, 0.2);
  }

  .dify-title {
    font-size: 24px;
  }
}
`

const APP_TSX = `export function App() {
  const modules = ['BunContainer', 'VFS', 'Runtime', 'Preview']

  return (
    <div className='dify-shell'>
      <header className='dify-header'>
        <div className='dify-brand'>BUN WEB EXAMPLE</div>
        <div className='dify-status'>Vite + React + TypeScript</div>
      </header>

      <div className='dify-main'>
        <aside className='dify-side'>
          {modules.map((moduleName, index) => (
            <div key={moduleName} className={index === 0 ? 'dify-side-item active' : 'dify-side-item'}>
              {moduleName}
            </div>
          ))}
        </aside>

        <section className='dify-content'>
          <h1 className='dify-title'>Dify 风格示例工作台</h1>
          <div className='dify-subtitle'>该模板用于验证 BunContainer 启动、挂载与执行链路。</div>
          <div className='dify-card'>
            <h2 className='dify-card-title'>运行方式</h2>
            <div className='dify-card-body'>bun run /src/example-run.ts</div>
          </div>
        </section>
      </div>
    </div>
  )
}
`

const MAIN_TSX = `import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`

export function createBunWebExampleFiles(message = 'hello from bun-web-example'): FileTree {
  return {
    '/package.json': JSON.stringify({
      name: 'bun-web-example',
      type: 'module',
      private: true,
      scripts: {
        dev: 'vite',
        build: 'vite build',
        preview: 'vite preview',
      },
      dependencies: {
        react: '^18.3.1',
        'react-dom': '^18.3.1',
      },
      devDependencies: {
        '@types/react': '^18.3.24',
        '@types/react-dom': '^18.3.7',
        '@vitejs/plugin-react': '^4.3.4',
        typescript: '^6.0.2',
        vite: '^5.4.19',
      },
    }, null, 2),
    '/index.html': `<!doctype html>
<html lang='zh-CN'>
  <head>
    <meta charset='UTF-8' />
    <meta name='viewport' content='width=device-width, initial-scale=1.0' />
    <title>Bun Web Example</title>
  </head>
  <body>
    <div id='root'></div>
    <script type='module' src='/src/main.tsx'></script>
  </body>
</html>
`,
    '/tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        jsx: 'react-jsx',
        lib: ['ESNext', 'DOM', 'DOM.Iterable'],
        strict: true,
      },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    }, null, 2),
    '/vite.config.ts': VITE_CONFIG,
    '/src/App.tsx': APP_TSX,
    '/src/main.tsx': MAIN_TSX,
    '/src/styles.css': APP_STYLE,
    '/src/example-run.ts': `console.log(${JSON.stringify(message)})`,
  }
}

function withDependency(files: FileTree, packageName: string, version: string): FileTree {
  const pkg = JSON.parse(files['/package.json'] as string) as {
    dependencies?: Record<string, string>
  }

  pkg.dependencies = {
    ...(pkg.dependencies ?? {}),
    [packageName]: version,
  }

  return {
    ...files,
    '/package.json': JSON.stringify(pkg, null, 2),
  }
}

export function createBunWebExpressExampleFiles(message = 'express ecosystem acceptance ok'): FileTree {
  const files = createBunWebExampleFiles(message)
  const withExpress = withDependency(files, 'express', '^4.21.2')

  return {
    ...withExpress,
    '/src/express-run.ts': `function createExpressLike() {
  const middlewares = []
  const routes = new Map()

  const handleRequest = path => {
    const req = { path, trace: [] }
    const res = { body: '', status: 200 }

    let i = 0
    const run = () => {
      if (i < middlewares.length) {
        const fn = middlewares[i++]
        fn(req, res, run)
        return
      }

      const route = routes.get(req.path)
      if (route) {
        route(req, res, () => {})
        return
      }

      req.trace.push('route:404')
      res.status = 404
      res.body = 'not-found'
    }

    run()
    return { req, res }
  }

  return {
    use(fn) {
      middlewares.push(fn)
    },
    get(path, fn) {
      routes.set(path, fn)
    },
    listen(_port, onReady) {
      onReady()
      return {
        health: handleRequest('/health'),
        missing: handleRequest('/missing'),
      }
    },
  }
}

const app = createExpressLike()
app.use((req, _res, next) => {
  req.trace.push('mw:logger')
  next()
})
app.get('/health', (req, res) => {
  req.trace.push('route:health')
  res.body = 'ok'
})

const { health, missing } = app.listen(3000, () => {})
const matrix = [health, missing]
  .map(({ req, res }) => req.path + ':' + res.status + ':' + res.body)
  .join('|')

console.log(matrix)
console.log(health.req.trace.join('>'))
console.log(health.res.body)
console.log(${JSON.stringify(message)})`,
  }
}

export function createBunWebKoaExampleFiles(message = 'koa ecosystem acceptance ok'): FileTree {
  const files = createBunWebExampleFiles(message)
  const withKoa = withDependency(files, 'koa', '^2.15.4')

  return {
    ...withKoa,
    '/src/koa-run.ts': `function compose(middlewares) {
  return function run(ctx) {
    const dispatch = index => {
      const fn = middlewares[index]
      if (!fn) return Promise.resolve()
      return fn(ctx, () => dispatch(index + 1))
    }

    return dispatch(0)
  }
}

const app = {
  middlewares: [],
  use(fn) {
    this.middlewares.push(fn)
  },
}

app.use(async (ctx, next) => {
  ctx.trace.push('mw:before')
  await next()
  ctx.trace.push('mw:after')
})

app.use(async ctx => {
  if (ctx.path === '/health') {
    ctx.trace.push('route:health')
    ctx.status = 200
    ctx.body = 'ok'
    return
  }

  ctx.trace.push('route:404')
  ctx.status = 404
  ctx.body = 'not-found'
})

const run = compose(app.middlewares)
const request = async path => {
  const ctx = { path, body: '', status: 0, trace: [] }
  await run(ctx)
  return ctx
}

const health = await request('/health')
const missing = await request('/missing')
const matrix = [health, missing]
  .map(ctx => ctx.path + ':' + ctx.status + ':' + ctx.body)
  .join('|')

console.log(matrix)
console.log(health.trace.join('>'))
console.log(health.body)
console.log(${JSON.stringify(message)})`,
  }
}

export function createBunWebFastifyExampleFiles(message = 'fastify ecosystem acceptance ok'): FileTree {
  const files = createBunWebExampleFiles(message)
  const withFastify = withDependency(files, 'fastify', '^4.28.1')

  return {
    ...withFastify,
    '/src/fastify-run.ts': `function createFastifyLike() {
  const hooks = []
  const routes = new Map()

  return {
    addHook(name, fn) {
      if (name === 'onRequest') hooks.push(fn)
    },
    get(path, fn) {
      routes.set(path, fn)
    },
    async inject(path) {
      const req = { url: path, trace: [] }
      const reply = { statusCode: 200, payload: '' }

      for (const hook of hooks) {
        await hook(req, reply)
      }

      const route = routes.get(path)
      if (!route) {
        req.trace.push('route:404')
        reply.statusCode = 404
        reply.payload = 'not-found'
        return { req, reply }
      }

      await route(req, reply)
      return { req, reply }
    },
  }
}

const app = createFastifyLike()

app.addHook('onRequest', async req => {
  req.trace.push('hook:onRequest')
})

app.get('/health', async (req, reply) => {
  req.trace.push('route:health')
  reply.payload = 'ok'
})

const health = await app.inject('/health')
const missing = await app.inject('/missing')
const matrix = [health, missing]
  .map(({ req, reply }) => req.url + ':' + reply.statusCode + ':' + reply.payload)
  .join('|')

console.log(matrix)
console.log(health.req.trace.join('>'))
console.log(health.reply.payload)
console.log(${JSON.stringify(message)})`,
  }
}

export function createBunWebHonoExampleFiles(message = 'hono ecosystem acceptance ok'): FileTree {
  const files = createBunWebExampleFiles(message)
  const withHono = withDependency(files, 'hono', '^4.6.10')

  return {
    ...withHono,
    '/src/hono-run.ts': `function createHonoLike() {
  const middlewares = []
  const routes = new Map()

  const app = {
    use(path, fn) {
      middlewares.push({ path, fn })
    },
    get(path, fn) {
      routes.set(path, fn)
    },
    async request(path) {
      const ctx = { path, text: '', status: 200, trace: [] }

      let index = 0
      const dispatch = async () => {
        const current = middlewares[index++]
        if (!current) return
        if (path.startsWith(current.path)) {
          await current.fn(ctx, dispatch)
          return
        }
        await dispatch()
      }

      await dispatch()

      const route = routes.get(path)
      if (!route) {
        ctx.trace.push('route:404')
        ctx.status = 404
        ctx.text = 'not-found'
        return ctx
      }

      await route(ctx)
      return ctx
    },
  }

  return app
}

const app = createHonoLike()
app.use('/api', async (c, next) => {
  c.trace.push('mw:api')
  await next()
})
app.get('/api/health', async c => {
  c.trace.push('route:health')
  c.text = 'ok'
})

const health = await app.request('/api/health')
const missing = await app.request('/api/missing')
const matrix = [health, missing]
  .map(c => c.path + ':' + c.status + ':' + c.text)
  .join('|')

console.log(matrix)
console.log(health.trace.join('>'))
console.log(health.text)
console.log(${JSON.stringify(message)})`,
  }
}

export function createBunWebServeRoutesExampleFiles(message = 'bun serve routes acceptance ok'): FileTree {
  const files = createBunWebExampleFiles(message)

  return {
    ...files,
    '/src/serve-routes-run.ts': `function createServeLike() {
  const routes = new Map()

  return {
    route(path, handler) {
      routes.set(path, handler)
    },
    async fetch(path) {
      const handler = routes.get(path)
      if (!handler) {
        return { path, status: 404, body: 'not-found' }
      }
      return handler(path)
    },
  }
}

const server = createServeLike()
server.route('/ok', async path => ({ path, status: 200, body: 'ok' }))
server.route('/json', async path => ({ path, status: 200, body: JSON.stringify({ ok: true }) }))

const ok = await server.fetch('/ok')
const json = await server.fetch('/json')
const missing = await server.fetch('/missing')
const matrix = [ok, json, missing]
  .map(item => item.path + ':' + item.status + ':' + item.body)
  .join('|')

console.log(matrix)
console.log(ok.body)
console.log(${JSON.stringify(message)})`,
  }
}

const EXAMPLE_SCENARIOS: Record<BunWebExampleUseCase, BunWebExampleScenario> = {
  'vite-react-ts': {
    id: 'vite-react-ts',
    title: 'Vite + React + TypeScript',
    description: '基础容器链路与前端模板 smoke。',
    defaultEntrypoint: '/src/example-run.ts',
    createFiles: message => createBunWebExampleFiles(message),
  },
  express: {
    id: 'express',
    title: 'Express',
    description: 'Express 风格中间件与路由执行 smoke。',
    defaultEntrypoint: '/src/express-run.ts',
    createFiles: message => createBunWebExpressExampleFiles(message),
  },
  koa: {
    id: 'koa',
    title: 'Koa',
    description: 'Koa compose 与中间件链路 smoke。',
    defaultEntrypoint: '/src/koa-run.ts',
    createFiles: message => createBunWebKoaExampleFiles(message),
  },
  fastify: {
    id: 'fastify',
    title: 'Fastify',
    description: 'Fastify hook + route 注入链路 smoke。',
    defaultEntrypoint: '/src/fastify-run.ts',
    createFiles: message => createBunWebFastifyExampleFiles(message),
  },
  hono: {
    id: 'hono',
    title: 'Hono',
    description: 'Hono 路由分组与中间件链路 smoke。',
    defaultEntrypoint: '/src/hono-run.ts',
    createFiles: message => createBunWebHonoExampleFiles(message),
  },
  'bun-serve-routes': {
    id: 'bun-serve-routes',
    title: 'Bun Serve Routes',
    description: 'Bun.serve 风格路由 dispatch smoke。',
    defaultEntrypoint: '/src/serve-routes-run.ts',
    createFiles: message => createBunWebServeRoutesExampleFiles(message),
  },
}

export function listBunWebExampleScenarios(): BunWebExampleScenario[] {
  return Object.values(EXAMPLE_SCENARIOS)
}

export function getBunWebExampleScenario(useCase: BunWebExampleUseCase): BunWebExampleScenario {
  return EXAMPLE_SCENARIOS[useCase]
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []

  while (true) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(result.value)
  }

  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(merged)
}

export async function runBunWebExample(options: BunWebExampleOptions = {}): Promise<BunWebExampleResult> {
  const useCase = options.useCase ?? 'vite-react-ts'
  const scenario = getBunWebExampleScenario(useCase)
  const container = options.container ?? await BunContainer.boot(options.boot)
  const previewManager = new PreviewManager()
  const unbindPreview = previewManager.bind(container)
  const fallbackMessage = options.message ?? `${scenario.title.toLowerCase()} example`
  const files = options.files ?? options.boot?.files ?? scenario.createFiles(fallbackMessage)
  const entrypoint = options.entrypoint ?? scenario.defaultEntrypoint

  await container.mount(files)

  const proc = await container.spawn('bun', ['run', entrypoint])
  const [output, exitCode] = await Promise.all([streamToString(proc.output), proc.exited])
  const previewURL = previewManager.getCurrentURL()
  unbindPreview()

  return {
    container,
    useCase,
    entrypoint,
    exitCode,
    output,
    previewManager,
    previewURL,
  }
}