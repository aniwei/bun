import { title } from "./title"
import * as cycleA from "./cycle-a"

export const view = <main>{title}</main>

export async function loadMessage() {
  const messageModule = await import("./message")
  const config = require("./config.json")

  return `${messageModule.message}:${config.suffix}`
}

export function loadCommonJsValue() {
  return require("./feature.cjs").value
}

export function loadCyclicValue() {
  return `${cycleA.readCycleB()}:${cycleA.readCycleBThroughCycle()}`
}
