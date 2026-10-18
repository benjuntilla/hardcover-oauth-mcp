/**
 * End-to-end token lifecycle: refreshing Hardcover tokens behind the scenes,
 * refreshing MCP tokens, and revocation sending the client back to
 * authorization.
 */
import { Array as Arr, Effect, Option, Schema, pipe } from "effect"
import { BASE, Mock } from "#test/e2e-setup.ts"
import { approved, refresh } from "#test/oauth-client.ts"
import type { Authorized } from "#test/client-authorize.ts"
import type { CaseError } from "#test/e2e-setup.ts"
import type { HttpClient } from "effect/http"
import type { MockHardcover } from "#test/mock-hardcover.ts"
import { currentSession } from "#test/e2e-session.ts"
import { decodeJson } from "#test/client-http.ts"
import { expect } from "bun:test"
import { mcp } from "#test/client-mcp.ts"

const BAD_REQUEST = 400
const CONCURRENT_CALLS = 3
const OK = 200
const ONE_REFRESH = 1
const UNAUTHORIZED = 401

const ToolResult = Schema.Struct({ result: Schema.Struct({ isError: Schema.Boolean }) })
const TextContent = Schema.Struct({ text: Schema.String })
const Reconnect = Schema.Struct({ result: Schema.Struct({ content: Schema.Array(TextContent), isError: Schema.Boolean }) })
const RefreshedTokens = Schema.Struct({ access_token: Schema.String })
const GrantError = Schema.Struct({ error: Schema.String })

const callMe = (token: string): ReturnType<typeof mcp> =>
  mcp({ base: BASE, method: "tools/call", params: { arguments: {}, name: "hardcover_me" }, token })

const refreshGrants = (mock: MockHardcover): number =>
  pipe(
    mock.tokenRequests,
    Arr.filter((request) => request.grant_type === "refresh_token"),
  ).length

const hardcoverRefresh = Effect.gen(function* refreshHardcoverOnce() {
  const mock = yield* Mock
  const session = yield* currentSession
  mock.expireAccessTokens()
  const before = refreshGrants(mock)
  const calls = yield* Effect.all(Arr.replicate(callMe(session.tokens.access_token), CONCURRENT_CALLS), { concurrency: "unbounded" })
  for (const call of calls) {
    const { result } = yield* decodeJson({ response: call, schema: ToolResult })
    expect(result.isError).toBe(false)
  }
  expect(refreshGrants(mock) - before).toBe(ONE_REFRESH)
})

const mcpRefresh = Effect.gen(function* refreshMcpTokens() {
  const session = yield* currentSession
  const response = yield* refresh({ base: BASE, clientId: session.clientId, refreshToken: session.tokens.refresh_token })
  expect(response.status).toBe(OK)
  const tokens = yield* decodeJson({ response, schema: RefreshedTokens })
  const call = yield* callMe(tokens.access_token)
  expect(call.status).toBe(OK)
})

const refusedAfterRevocation = (revoked: Authorized): Effect.Effect<void, CaseError, HttpClient.HttpClient> =>
  Effect.gen(function* refuseRevokedTokens() {
    const next = yield* callMe(revoked.tokens.access_token)
    expect(next.status).toBe(UNAUTHORIZED)
    expect(next.headers["www-authenticate"]).toContain("invalid_token")
    const refreshed = yield* refresh({ base: BASE, clientId: revoked.clientId, refreshToken: revoked.tokens.refresh_token })
    expect(refreshed.status).toBe(BAD_REQUEST)
    expect((yield* decodeJson({ response: refreshed, schema: GrantError })).error).toBe("invalid_grant")
  })

const revocation = Effect.gen(function* reauthorizeAfterRevocation() {
  const revoked = yield* approved({ base: BASE })
  const mock = yield* Mock
  mock.revokeAll()
  const first = yield* decodeJson({ response: yield* callMe(revoked.tokens.access_token), schema: Reconnect })
  expect(first.result.isError).toBe(true)
  const firstText = pipe(
    Arr.head(first.result.content),
    Option.map((item) => item.text),
    Option.getOrUndefined,
  )
  expect(firstText).toContain("Reconnect")
  yield* refusedAfterRevocation(revoked)
})

/**
 * Application module, not a public API.
 * @internal
 */
export { hardcoverRefresh, mcpRefresh, revocation }
