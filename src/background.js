// Pacing for the startup backfills and the vector indexer. They all walk
// history in batches, and better-sqlite3 and the embedder both block the
// thread they run on, so each batch is followed by a rest: `ratio` times as
// long as the batch took, never less than `minMs`. With ratio 1 a walk uses
// at most half of one core, and live requests queue behind one batch at
// most. Ratio 0 and minMs 0 is a plain one-turn yield, which is what the
// tests use.
export function throttle({ ratio = 1, minMs = 0 } = {}) {
  let since = Date.now()
  return async () => {
    const busy = Date.now() - since
    const rest = Math.max(minMs, busy * ratio)
    await new Promise((r) => (rest > 0 ? setTimeout(r, rest) : setImmediate(r)))
    since = Date.now()
  }
}

export const yieldTurn = () => new Promise((r) => setImmediate(r))

// A wait that `cancel()` cuts short, so close() never has to sit out the
// startup delay before it can shut down.
export function cancellableDelay(ms) {
  let timer
  let done
  const promise = new Promise((r) => {
    done = r
    timer = ms > 0 ? setTimeout(r, ms) : setImmediate(r)
  })
  return {
    promise,
    cancel() {
      clearTimeout(timer)
      clearImmediate(timer)
      done()
    },
  }
}
