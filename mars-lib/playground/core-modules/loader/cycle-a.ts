import * as cycleB from "./cycle-b"

export const value = "cycle-a"

export function readCycleB() {
  return cycleB.value
}

export function readCycleBThroughCycle() {
  return cycleB.readCycleA()
}
