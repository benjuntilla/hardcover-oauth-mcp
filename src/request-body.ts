/** The cap on request bodies: every body is read up front, at most `MAX_BODY_BYTES` of it. */
import { Array as Arr, Effect, Option, Stream, pipe } from "effect"

/** The largest request body the Worker reads. Its largest real ones, MCP tool calls carrying a review or a journal entry, are a few KB. */
const MAX_BODY_BYTES = 1_048_576
const NO_BYTES = 0

/** One chunk of a request body, with the body's size up to and including it. */
interface CountedChunk {
  readonly chunk: Uint8Array
  readonly total: number
}

const declaredTooLarge = (request: Request): boolean => Number(request.headers.get("content-length") ?? NO_BYTES) > MAX_BODY_BYTES

const countChunk = (total: number, chunk: Uint8Array): readonly [number, ReadonlyArray<CountedChunk>] => {
  const next = total + chunk.byteLength
  return [next, [{ chunk, total: next }]]
}

const overCap = (counted: CountedChunk): boolean => counted.total > MAX_BODY_BYTES

/**
 * The request around its body, read in full, or none when the body went over the cap.
 * @param {Request} request The incoming request.
 * @param {ReadonlyArray<CountedChunk>} chunks The body's chunks, up to the one that went over the cap.
 * @returns {Option.Option<Request>} The request, ready to read again.
 */
const rebuilt = (request: Request, chunks: ReadonlyArray<CountedChunk>): Option.Option<Request> => {
  if (pipe(Arr.last(chunks), Option.exists(overCap))) {
    return Option.none()
  }
  const body = new Blob(
    pipe(
      chunks,
      Arr.map((counted) => counted.chunk),
    ),
  )
  return Option.some(new Request(request.url, { body, headers: request.headers, method: request.method }))
}

/**
 * The request with its body read in full, or none when the body is over `MAX_BODY_BYTES` or can't be read. Reading stops
 * as soon as the body passes the cap, also for bodies sent without a `Content-Length`. Reading every body here also keeps
 * the connection reusable when a check below refuses the request: workerd closes a keep-alive connection whose request
 * body went unread, without `Connection: close`, so the client's next request on it fails with ECONNRESET.
 * @param {Request} request The incoming request.
 * @returns {Effect.Effect<Option.Option<Request>>} The request, ready to read again.
 */
const withBoundedBody = (request: Request): Effect.Effect<Option.Option<Request>> =>
  Option.match(Option.fromNullishOr(request.body), {
    onNone: () => Effect.succeedSome(request),
    onSome: (body) =>
      declaredTooLarge(request)
        ? Effect.succeedNone
        : Stream.fromReadableStream<Uint8Array, unknown>({ evaluate: () => body, onError: (error) => error }).pipe(
            Stream.mapAccum(() => NO_BYTES, countChunk),
            Stream.takeUntil(overCap),
            Stream.runCollect,
            Effect.map((chunks) => rebuilt(request, chunks)),
            Effect.orElseSucceed(() => Option.none()),
          ),
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { MAX_BODY_BYTES, withBoundedBody }
