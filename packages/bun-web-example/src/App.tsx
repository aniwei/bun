import { useState } from 'react'
import {
  listBunWebExampleScenarios,
  runBunWebExample,
  type BunWebExampleUseCase,
} from './index'

export function App() {
  const modules = ['BunContainer', 'VFS', 'Runtime', 'Preview']
  const scenarios = listBunWebExampleScenarios()
  const [selectedUseCase, setSelectedUseCase] = useState<BunWebExampleUseCase>('vite-react-ts')
  const [isRunning, setIsRunning] = useState(false)
  const [output, setOutput] = useState('尚未执行')

  const activeScenario = scenarios.find(item => item.id === selectedUseCase) ?? scenarios[0]!

  const handleRunExample = async () => {
    setIsRunning(true)
    setOutput('运行中...')

    try {
      const result = await runBunWebExample({
        useCase: selectedUseCase,
        message: `${selectedUseCase} from app runtime`,
      })

      const normalized = result.output.trimEnd()
      const previewLine = result.previewURL ? `\npreview=${result.previewURL}` : ''
      setOutput(`exit=${result.exitCode}${previewLine}\n${normalized}`)

      await result.container.shutdown()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setOutput(`run failed: ${message}`)
    } finally {
      setIsRunning(false)
    }
  }

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
            <div className='dify-card-body'>bun run {activeScenario.defaultEntrypoint}</div>
            <div className='dify-scenario-grid'>
              <label className='dify-scenario-label' htmlFor='example-use-case'>示例用例</label>
              <select
                id='example-use-case'
                className='dify-scenario-select'
                value={selectedUseCase}
                onChange={event => setSelectedUseCase(event.target.value as BunWebExampleUseCase)}
                disabled={isRunning}
              >
                {scenarios.map(item => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </div>
            <div className='dify-card-body'>{activeScenario.description}</div>
            <div className='dify-actions'>
              <button className='dify-run-btn' onClick={handleRunExample} disabled={isRunning} type='button'>
                {isRunning ? '运行中...' : '在页面内执行 runBunWebExample'}
              </button>
            </div>
            <div className='dify-card-body'>{output}</div>
          </div>
        </section>
      </div>
    </div>
  )
}