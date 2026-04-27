export const processWorkerBootstrapArgv = ["bun", "run", "worker-entry.ts", "--from-playground"]
export const processWorkerBootstrapCwd = "/workspace/runtime"
export const processWorkerBootstrapEnv = { MARS_WORKER_CONTEXT: "playground" }
export const processWorkerBootstrapRequireSpecifier = "./worker-config.cjs"
export const processWorkerBootstrapConfigValue = "worker bootstrap config"