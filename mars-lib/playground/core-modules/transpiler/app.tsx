import { title as heading } from "./title"

export const view = <main>{heading}</main>

export async function loadMessage() {
  const messageModule = await import("./message")

  return messageModule.message
}
