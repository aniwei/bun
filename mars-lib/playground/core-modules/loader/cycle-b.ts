import * as cycleA from "./cycle-a"

export const value = "cycle-b"

export function readCycleA() {
  return cycleA.value
}
