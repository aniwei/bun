import { detectMarsCapabilities } from "@mars/kernel"

import type { MarsRuntimeCapabilities } from "@mars/kernel"

export type BrowserProfileId = "async-fallback" | "sab-worker" | "opfs-persistence" | "service-worker-modules"

export interface BrowserTestProfile {
  id: BrowserProfileId
  enabled: boolean
  capabilities: Partial<Record<keyof MarsRuntimeCapabilities, boolean>>
  notes: string
}

export function createBrowserTestProfiles(
  capabilities: MarsRuntimeCapabilities = detectMarsCapabilities(),
): BrowserTestProfile[] {
  return [
    {
      id: "async-fallback",
      enabled: true,
      capabilities: {},
      notes: "Baseline profile for browsers without SharedArrayBuffer or OPFS.",
    },
    {
      id: "sab-worker",
      enabled: capabilities.sharedArrayBuffer && capabilities.atomicsWait && capabilities.worker,
      capabilities: {
        sharedArrayBuffer: true,
        atomicsWait: true,
        worker: true,
      },
      notes: "Enables sync worker and spawnSync research paths when SAB is available.",
    },
    {
      id: "opfs-persistence",
      enabled: capabilities.opfs,
      capabilities: {
        opfs: true,
      },
      notes: "Enables persistent VFS snapshot and restore coverage.",
    },
    {
      id: "service-worker-modules",
      enabled: capabilities.serviceWorker,
      capabilities: {
        serviceWorker: true,
      },
      notes: "Enables real ServiceWorker fetch and module graph coverage.",
    },
  ]
}
