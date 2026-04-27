import { message } from "./message"

export const title: string = __MARS_LABEL__

export function render() {
  return <main>{`${title}:${message}`}</main>
}
