import { useEffect, useMemo, useState } from "react"

import {
  ensurePlaygroundRuntimeStatus,
  isPlaygroundCaseRunnable,
  moduleCases,
  runPlaygroundCase,
  runRunnablePlaygroundCases,
} from "./browser-runtime"

import type { PlaygroundRunResult, PlaygroundRuntimeStatus } from "./browser-runtime"

export function App() {
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<PlaygroundRunResult[]>([])
  const [runtimeStatus, setRuntimeStatus] = useState<PlaygroundRuntimeStatus | null>(null)
  const runnableCases = useMemo(() => {
    return moduleCases.filter(playgroundCase => isPlaygroundCaseRunnable(playgroundCase.id))
  }, [])
  const phases = useMemo(() => {
    return Array.from(new Set(runnableCases.map(playgroundCase => playgroundCase.phase)))
  }, [])

  async function runAll() {
    setRunning(true)
    setResults(await runRunnablePlaygroundCases())
    setRuntimeStatus(await ensurePlaygroundRuntimeStatus())
    setRunning(false)
  }

  async function runOne(id: string) {
    setRunning(true)
    setResults(currentResults => currentResults.filter(result => result.id !== id))
    const result = await runPlaygroundCase(id)
    setResults(currentResults => [...currentResults, result])
    setRunning(false)
  }

  async function refreshRuntimeStatus() {
    setRuntimeStatus(await ensurePlaygroundRuntimeStatus())
  }

  useEffect(() => {
    void refreshRuntimeStatus()
  }, [])

  return (
    <main className="shell">
      <header className="toolbar">
        <div>
          <h1>Mars-lib Playground</h1>
          <p>Vite + TypeScript + React</p>
        </div>
        <button type="button" onClick={runAll} disabled={running}>
          {running ? "Running" : "Run All"}
        </button>
      </header>

      <section className="runtime-strip" aria-label="runtime status">
        <div className="runtime-strip-main">
          <span className="case-module">Browser Runtime</span>
          <div className="runtime-status-row">
            <RuntimeBadge label="Secure" ok={runtimeStatus?.secureContext === true} />
            <RuntimeBadge label="SAB" ok={runtimeStatus?.sharedArrayBuffer === true} />
            <RuntimeBadge label="Isolated" ok={runtimeStatus?.crossOriginIsolated === true} />
            <RuntimeBadge label="Service Worker" ok={runtimeStatus?.serviceWorkerReady === true} />
            <RuntimeBadge label="Controller" ok={runtimeStatus?.serviceWorkerControlled === true} />
          </div>
          <dl className="runtime-details">
            <div>
              <dt>Origin</dt>
              <dd>{runtimeStatus?.origin ?? "starting"}</dd>
            </div>
            <div>
              <dt>SW script</dt>
              <dd>{runtimeStatus?.serviceWorkerScriptURL ?? "starting"}</dd>
            </div>
            <div>
              <dt>SW scope</dt>
              <dd>{runtimeStatus?.serviceWorkerScope ?? "/"}</dd>
            </div>
            <div>
              <dt>SW state</dt>
              <dd>{runtimeStatus?.serviceWorkerState ?? "starting"}</dd>
            </div>
            <div>
              <dt>Controller</dt>
              <dd>{runtimeStatus?.serviceWorkerControllerURL ?? (runtimeStatus?.serviceWorkerRequiresReload ? "reload to claim page" : "not controlling yet")}</dd>
            </div>
          </dl>
          {runtimeStatus?.error ? <pre>{runtimeStatus.error}</pre> : null}
        </div>
        <button type="button" onClick={refreshRuntimeStatus} disabled={running}>
          Start / Refresh SW
        </button>
      </section>

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

function RuntimeBadge(props: { label: string; ok: boolean }) {
  return (
    <span className={props.ok ? "status pass" : "status fail"}>
      {props.label}
    </span>
  )
}
