import { useMemo, useState } from "react"

import {
  isPlaygroundCaseRunnable,
  moduleCases,
  runPlaygroundCase,
  runRunnablePlaygroundCases,
} from "./browser-runtime"

import type { PlaygroundRunResult } from "./browser-runtime"

export function App() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<PlaygroundRunResult[]>([])
  const runnableCases = useMemo(() => {
    return moduleCases.filter(playgroundCase => isPlaygroundCaseRunnable(playgroundCase.id))
  }, [])
  const phases = useMemo(() => {
    return Array.from(new Set(runnableCases.map(playgroundCase => playgroundCase.phase)))
  }, [])

  async function runAll() {
    setRunning(true)
    setResults(await runRunnablePlaygroundCases())
    setRunning(false)
  }

  async function runOne(id: string) {
    setRunning(true)
    setResults(currentResults => currentResults.filter(result => result.id !== id))
    const result = await runPlaygroundCase(id)
    setResults(currentResults => [...currentResults, result])
    setRunning(false)
  }

  return (
    <main className="shell">
      <header className="toolbar">
        <div>
          <h1>Mars-lib Playground</h1>
          <p>Vite + TypeScript + React</p>
        </div>
        <button type="button" onClick={runAll} disabled={running}>
          {running ? "Running" : "Run Phase 1 + 2"}
        </button>
      </header>

      {phases.map(phase => (
        <section className="case-section" key={phase}>
          <h2>{phase}</h2>
          <div className="case-grid">
            {runnableCases.filter(playgroundCase => playgroundCase.phase === phase).map(playgroundCase => {
              const result = results.find(item => item.id === playgroundCase.id)

              return (
                <article className="case-row" key={playgroundCase.id}>
                  <div className="case-main">
                    <span className="case-module">{playgroundCase.module}</span>
                    <h3>{playgroundCase.id}</h3>
                    <p>{playgroundCase.description}</p>
                    <code>{playgroundCase.entry}</code>
                  </div>
                  <div className="case-actions">
                    <span className={result?.ok ? "status pass" : result ? "status fail" : "status idle"}>
                      {result ? (result.ok ? "PASS" : "FAIL") : playgroundCase.status}
                    </span>
                    <button type="button" onClick={() => runOne(playgroundCase.id)} disabled={running}>
                      Run
                    </button>
                  </div>
                  {result ? <pre>{result.detail}</pre> : null}
                </article>
              )
            })}
          </div>
        </section>
      ))}
    </main>
  )
}
