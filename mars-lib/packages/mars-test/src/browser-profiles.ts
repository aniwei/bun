import { detectMarsCapabilities } from "@mars/kernel"

import type { MarsRuntimeCapabilities } from "@mars/kernel"

export type BrowserProfileId = "async-fallback" | "sab-worker" | "opfs-persistence" | "service-worker-modules"
export type BrowserEngine = "chromium" | "firefox"

export type BrowserAutomationProfileId =
  | "chromium-sab-service-worker"
  | "chromium-opfs-persistence"
  | "firefox-async-fallback"
  | "firefox-service-worker-modules"

export interface BrowserTestProfile {
  id: BrowserProfileId
  enabled: boolean
  capabilities: Partial<Record<keyof MarsRuntimeCapabilities, boolean>>
  notes: string
}

export interface BrowserAutomationProfile {
  id: BrowserAutomationProfileId
  engine: BrowserEngine
  enabled: boolean
  requiredCapabilities: Partial<Record<keyof MarsRuntimeCapabilities, boolean>>
  profileIds: BrowserProfileId[]
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

export function createBrowserAutomationProfiles(
  capabilities: MarsRuntimeCapabilities = detectMarsCapabilities(),
): BrowserAutomationProfile[] {
  return [
    {
      id: "chromium-sab-service-worker",
      engine: "chromium",
      enabled: capabilities.sharedArrayBuffer && capabilities.atomicsWait && capabilities.worker && capabilities.serviceWorker,
      requiredCapabilities: {
        sharedArrayBuffer: true,
        atomicsWait: true,
        worker: true,
        serviceWorker: true,
      },
      profileIds: ["sab-worker", "service-worker-modules"],
      notes: "Chromium profile for cross-origin-isolated SAB, Worker, and ServiceWorker module coverage.",
    },
    {
      id: "chromium-opfs-persistence",
      engine: "chromium",
      enabled: capabilities.opfs,
      requiredCapabilities: {
        opfs: true,
      },
      profileIds: ["opfs-persistence"],
      notes: "Chromium profile for OPFS-backed snapshot persistence coverage.",
    },
    {
      id: "firefox-async-fallback",
      engine: "firefox",
      enabled: true,
      requiredCapabilities: {},
      profileIds: ["async-fallback"],
      notes: "Firefox baseline profile for async fallback paths when SAB or OPFS are unavailable.",
    },
    {
      id: "firefox-service-worker-modules",
      engine: "firefox",
      enabled: capabilities.serviceWorker,
      requiredCapabilities: {
        serviceWorker: true,
      },
      profileIds: ["service-worker-modules"],
      notes: "Firefox profile for ServiceWorker registration and module response coverage.",
    },
  ]
}
