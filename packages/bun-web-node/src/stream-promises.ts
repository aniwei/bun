import { Readable, Writable } from './events-stream'

type MinimalStream = {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

type InternalReadableState = {
  ended?: boolean
  queue?: unknown[]
}

type InternalWritableState = {
  ending?: boolean
  writing?: boolean
  buffered?: unknown[]
}

function onceEvent(stream: MinimalStream, event: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    stream.on(event, (...args: unknown[]) => resolve(args))
  })
}

export async function finished(stream: MinimalStream): Promise<void> {
  const readable = stream as InternalReadableState
  if (readable.ended && (!readable.queue || readable.queue.length === 0)) {
    return
  }

  const writable = stream as InternalWritableState
  if (writable.ending && !writable.writing && (!writable.buffered || writable.buffered.length === 0)) {
    return
  }

  await Promise.race([
    onceEvent(stream, 'error').then(([err]) => Promise.reject(err)),
    onceEvent(stream, 'finish'),
    onceEvent(stream, 'end'),
  ])
}

export async function pipeline(...streams: MinimalStream[]): Promise<void> {
  if (streams.length < 2) {
    throw new Error('pipeline requires at least 2 streams')
  }

  const finishedPromise = finished(streams[streams.length - 1])

  for (let i = 0; i < streams.length - 1; i += 1) {
    const from = streams[i] as Readable
    const to = streams[i + 1] as Writable
    from.pipe(to)
  }

  await finishedPromise
}

export default {
  finished,
  pipeline,
}