import { EventType, type StreamChunk } from '@tanstack/ai'

/**
 * A one-way buffer between a server-side agent run and the HTTP response that shows it (#128).
 *
 * The run pushes chunks in; the response reads them out. When the client goes away (it leaves the
 * page, or follows "Watch the steps"), the response calls `return()` or the request aborts, and the
 * relay detaches: later pushes are dropped, and the run carries on. Nothing here can stop the run.
 */
export function createRelay() {
  const queue: StreamChunk[] = []
  let waiter: ((r: IteratorResult<StreamChunk>) => void) | null = null
  let ended = false
  let detached = false
  const done: IteratorResult<StreamChunk> = { value: undefined, done: true }

  const settle = () => {
    if (!waiter) return
    const w = waiter
    if (queue.length) {
      waiter = null
      w({ value: queue.shift()!, done: false })
    } else if (ended || detached) {
      waiter = null
      w(done)
    }
  }

  const detach = () => {
    detached = true
    queue.length = 0
    settle()
  }

  const iterable: AsyncIterable<StreamChunk> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (detached) return Promise.resolve(done)
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false })
        if (ended) return Promise.resolve(done)
        return new Promise<IteratorResult<StreamChunk>>((resolve) => {
          waiter = resolve
        })
      },
      // The response stops reading: the client disconnected. Detach, never cancel.
      return: () => {
        detach()
        return Promise.resolve(done)
      },
    }),
  }

  return {
    iterable,
    push(chunk: StreamChunk) {
      if (detached || ended) return
      queue.push(chunk)
      settle()
    },
    end() {
      ended = true
      settle()
    },
    detach,
    get detached() {
      return detached
    },
  }
}

/** True for the events that end a run on the client (RUN_FINISHED, RUN_ERROR). */
export function isTerminal(chunk: StreamChunk) {
  return chunk.type === EventType.RUN_FINISHED || chunk.type === EventType.RUN_ERROR
}

/** An AG-UI CUSTOM event. The chat client receives it through `onCustomEvent`. */
export function customEvent(name: string, value: Record<string, unknown>): StreamChunk {
  return { type: EventType.CUSTOM, name, value, timestamp: Date.now() } as unknown as StreamChunk
}

/** Custom event names shared with the chat page. */
export const RUN_EVENT = 'crosswire:run'
export const SAVED_EVENT = 'crosswire:saved'
