import { title } from "./title"

export const view = <main>{title}</main>

export async function loadMessage() {
  const messageModule = await import("./message")
  const config = require("./config.json")

  return `${messageModule.message}:${config.suffix}`
}

export function loadCommonJsValue() {
  return require("./feature.cjs").value
}
