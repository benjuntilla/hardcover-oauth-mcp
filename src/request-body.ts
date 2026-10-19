/** The cap on request bodies: every body is read up front, at most `MAX_BODY_BYTES` of it. */
import { Effect, Option, Schema, Stream } from "effect"

/** The largest request body the Worker reads. Its largest real ones, MCP tool calls carrying a review or a journal entry, are a few KB. */
const MAX_BODY_BYTES = 1_048_576

class BodyTooLarge extends Schema.TaggedError<BodyTooLarge, { readonly brand: unique symbol }>()("BodyTooLarge", {}) {}

/**
 * The request with its body read in full, or none when the body is over `MAX_BODY_BYTES` or can't be read. Reading stops
 * as soon as the body passes the cap, also for bodies sent without a `Content-Length`. Reading every body also keeps the
 * connection reusable when the Worker refuses the request: workerd closes a keep-alive connection whose request body
 * went unread, without `Connection: close`, so the client's next request on it fails with ECONNRESET.
 * @param {Request} request The incoming request.
 * @returns {Effect.Effect<Option.Option<Request>>} The request, ready to read again.
 */
const withBoundedBody = (request: Request): Effect.Effect<Option.Option<Request>> =>
  Option.match(Option.fromNullishOr(request.body), {
    onNone: () => Effect.succeedSome(request),
    onSome: (body) =>
      Stream.fromReadableStream<Uint8Array, unknown>({ evaluate: () => body, onError: (cause) => cause }).pipe(
        Stream.limitBytes(MAX_BODY_BYTES, () => Stream.fail<unknown>(BodyTooLarge.make({}))),
        Stream.mkArrayBuffer,
        Effect.map((bytes) => Option.some(new Request(request.url, { body: bytes, headers: request.headers, method: request.method }))),
        Effect.orElseSucceed(() => Option.none()),
      ),
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { MAX_BODY_BYTES, withBoundedBody }
