/**
 * Worker entry point. Static assets (`/`, `/privacy`, `/site.css`, the icons) are served
 * before this runs. `OAuthProvider` routes discovery, token, and registration
 * endpoints itself, `/mcp` to the MCP handler (with a validated token), and
 * `/authorize` and `/callback` to the default handler.
 */
import { Effect, Option, String as Str, pipe } from "effect"
import { html, messagePage } from "#src/oauth/pages.ts"
import type { Env } from "#src/env.ts"
import { json } from "#src/mcp/jsonrpc.ts"
import { providerFor } from "#src/oauth/provider.ts"
import { withBoundedBody } from "#src/request-body.ts"

const PAYLOAD_TOO_LARGE = 413
const TOO_MANY = 429
const RETRY_AFTER = "60"
const PURGE_BATCHES = 20
const LAST_BATCH = 1
const NEXT_BATCH = 1

/**
 * The rate limiter for an unauthenticated endpoint, limited per client IP, or none when the path isn't limited.
 * @param {Env} env The Worker bindings.
 * @param {string} pathname The request path.
 * @returns {Option.Option<RateLimit>} The limiter.
 */
const ipLimit = (env: Env, pathname: string): Option.Option<RateLimit> => {
  if (pathname === "/register") {
    return Option.some(env.REGISTER_RATE_LIMIT)
  }
  if (pathname === "/token") {
    return Option.some(env.TOKEN_RATE_LIMIT)
  }
  if (pathname === "/authorize" || pathname === "/callback") {
    return Option.some(env.AUTHORIZE_RATE_LIMIT)
  }
  return Option.none()
}

/**
 * The response for a client that has made too many attempts.
 * @param {string} pathname The request path.
 * @returns {Response} The response.
 */
const tooManyRequests = (pathname: string): Response => {
  if (pathname === "/authorize" || pathname === "/callback") {
    return html({
      body: messagePage({ message: "Wait a minute, then start connecting again from your MCP client.", title: "Too many attempts" }),
      headers: new Headers({ "retry-after": RETRY_AFTER }),
      status: TOO_MANY,
    })
  }
  return json({
    body: { error: "temporarily_unavailable", error_description: "Too many requests. Retry in a minute." },
    headers: { "retry-after": RETRY_AFTER },
    status: TOO_MANY,
  })
}

const payloadTooLarge = (): Response =>
  json({
    body: { error: "invalid_request", error_description: "The request body is larger than 1 MiB." },
    status: PAYLOAD_TOO_LARGE,
  })

/**
 * Drops expired grants and tokens from KV, a batch at a time.
 * @param {Env} env The Worker bindings.
 * @returns {Effect.Effect<void>} Done once the purge finished or ran its batches.
 */
const purgeExpired = (env: Env): Effect.Effect<void> => {
  const provider = providerFor({ env, url: new URL(env.PUBLIC_URL === "" ? "https://localhost" : env.PUBLIC_URL) })
  const batch = (cursor: Option.Option<string>, remaining: number): Effect.Effect<void> =>
    Effect.gen(function* purgeBatch() {
      const options = Option.match(cursor, { onNone: () => ({}), onSome: (from) => ({ cursor: from }) })
      const result = yield* Effect.promise(() => provider.purgeExpiredData(env, options))
      const next = pipe(Option.fromNullishOr(result.cursor), Option.filter(Str.isNonEmpty))
      if (result.done || Option.isNone(next) || remaining === LAST_BATCH) {
        return
      }
      yield* batch(next, remaining - NEXT_BATCH)
    })
  return batch(Option.none(), PURGE_BATCHES)
}

const worker = {
  /**
   * Routes one request through the body cap, the rate limit, and the OAuth provider.
   * @param {Request} request The request.
   * @param {Env} env The Worker bindings.
   * @param {ExecutionContext} ctx The request context.
   * @returns {Promise<Response>} The response.
   */
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    return Effect.runPromise(
      Effect.gen(function* route() {
        const bounded = yield* withBoundedBody(request)
        if (Option.isNone(bounded)) {
          return payloadTooLarge()
        }
        const limiter = request.method === "OPTIONS" ? Option.none() : ipLimit(env, url.pathname)
        if (Option.isSome(limiter)) {
          const key = request.headers.get("cf-connecting-ip") ?? "unknown"
          const { success } = yield* Effect.promise(() => limiter.value.limit({ key }))
          if (!success) {
            return tooManyRequests(url.pathname)
          }
        }
        return yield* Effect.promise(() => providerFor({ env, url }).fetch(bounded.value, env, ctx))
      }),
    )
  },
  /**
   * Daily: drop expired grants and tokens from KV, a batch at a time.
   * @param {ScheduledController} _controller The scheduled event.
   * @param {Env} env The Worker bindings.
   * @returns {Promise<void>} Resolves once the purge finishes.
   */
  scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    return Effect.runPromise(purgeExpired(env))
  },
} satisfies ExportedHandler<Env>

/** Cloudflare finds the Durable Object class among the Worker's exports. */
export { HardcoverConnection } from "#src/connection/durable-object.ts"
export default worker
