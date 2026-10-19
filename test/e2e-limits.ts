/**
 * End-to-end limits: step-up for missing scopes, refused consent, and the
 * two rate limits. The rate limits run last because each one uses up the
 * minute's allowance.
 */
import { Array as Arr, Effect, Option, String as Str, pipe } from "effect"
import { approved, denied } from "#test/oauth-client.ts"
import { jsonBody, post } from "#test/client-http.ts"
import { BASE } from "#test/e2e-setup.ts"
import type { HttpClientResponse } from "effect/http"
import { currentSession } from "#test/e2e-session.ts"
import { expect } from "bun:test"
import { mcp } from "#test/client-mcp.ts"
import { toolNames } from "#test/e2e-cases.ts"

const FORBIDDEN = 403
const FIRST_TRY = 1
const MCP_ATTEMPTS = 130
const RATE_LIMITED = 429
const REFUSED_AGAIN = 5
const REGISTER_ATTEMPTS = 12
const RETRY_AFTER = "60"

const withoutWrites = (scopes: ReadonlyArray<string>): ReadonlyArray<string> =>
  pipe(
    scopes,
    Arr.filter((scope) => !pipe(scope, Str.startsWith("write:"))),
  )

const stepUp = Effect.gen(function* requireStepUp() {
  const limited = yield* approved({ base: BASE, pick: withoutWrites })
  const list = yield* mcp({ base: BASE, method: "tools/list", token: limited.tokens.access_token })
  expect(yield* toolNames(list)).not.toContain("hardcover_mutate")
  const call = yield* mcp({
    base: BASE,
    method: "tools/call",
    params: { arguments: { query: "mutation { insert_goal(object: {}) { id } }" }, name: "hardcover_mutate" },
    token: limited.tokens.access_token,
  })
  expect(call.status).toBe(FORBIDDEN)
  expect(call.headers["www-authenticate"]).toContain("insufficient_scope")
})

// Covered by unit tests of isAllowedUser; here, a denied consent returns access_denied to the client.
const refusal = Effect.gen(function* refuseConsent() {
  const refused = yield* denied({ base: BASE, decision: "deny" })
  expect(refused.denied.searchParams.get("error")).toBe("access_denied")
})

const limitedStatus = (response: HttpClientResponse.HttpClientResponse): boolean => response.status === RATE_LIMITED

/**
 * Repeats a request until it is rate limited, sending it at most `attempts` times.
 * @param {number} attempts The most requests to send.
 * @returns {object} Options for `Effect.repeat`.
 */
const untilLimited = (attempts: number): Readonly<{ times: number; until: typeof limitedStatus }> => ({
  times: attempts - FIRST_TRY,
  until: limitedStatus,
})

const retryAfterOf = (last: HttpClientResponse.HttpClientResponse): Option.Option<string> =>
  pipe(
    Option.liftPredicate(last, limitedStatus),
    Option.flatMapNullishOr((response) => response.headers["retry-after"]),
  )

/**
 * Repeats a refused request four more times at once. Each goes out on the connection the last 429 came back on, so a
 * server that closes connections after a refusal fails one of them with ECONNRESET.
 */
const refusedAgain: Readonly<{ times: number }> = { times: REFUSED_AGAIN - FIRST_TRY }

const discardBody = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<void> =>
  limitedStatus(response) ? Effect.void : Effect.ignore(response.arrayBuffer)

const accountLimit = Effect.gen(function* limitAccount() {
  const session = yield* currentSession
  const request = mcp({ base: BASE, method: "tools/list", token: session.tokens.access_token })
  const last = yield* request.pipe(Effect.tap(discardBody), Effect.repeat(untilLimited(MCP_ATTEMPTS)))
  expect(Option.getOrUndefined(retryAfterOf(last))).toBe(RETRY_AFTER)
  expect((yield* request.pipe(Effect.repeat(refusedAgain))).status).toBe(RATE_LIMITED)
})

const registrationLimit = Effect.gen(function* limitRegistration() {
  const body = yield* jsonBody({ client_name: "Flood", redirect_uris: ["http://127.0.0.1:9/cb"], token_endpoint_auth_method: "none" })
  const request = post({ body, headers: { "content-type": "application/json" }, url: `${BASE}/register` })
  const last = yield* request.pipe(Effect.repeat(untilLimited(REGISTER_ATTEMPTS)))
  expect(Option.getOrUndefined(retryAfterOf(last))).toBe(RETRY_AFTER)
  expect((yield* request.pipe(Effect.repeat(refusedAgain))).status).toBe(RATE_LIMITED)
})

/**
 * Application module, not a public API.
 * @internal
 */
export { accountLimit, refusal, registrationLimit, stepUp }
