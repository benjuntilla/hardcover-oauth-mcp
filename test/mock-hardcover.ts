/**
 * A stand-in for Hardcover's OAuth server and GraphQL API, for local
 * end-to-end runs. It auto-approves authorization, enforces PKCE and client
 * authentication, rotates refresh tokens (rejecting reuse), and answers
 * GraphQL from per-root-field handlers.
 */
import { AUTHORIZE_PATH, REVOKE_PATH, TOKEN_PATH, authenticated, authorize, discovery, token } from "#test/mock-oauth.ts"
import type { GraphCall, GraphHandler, MockUser, RecordedCalls } from "#test/mock-graphql.ts"
import { NOT_FOUND, UNAUTHORIZED, formFields, json, text } from "#test/mock-http.ts"
import { Effect } from "effect"
import type { RecordedRequests } from "#test/mock-store.ts"
import { answerGraphql } from "#test/mock-graphql.ts"
import { makeStore } from "#test/mock-store.ts"

const DEFAULT_CLIENT_ID = "test-id"
const DEFAULT_CLIENT_SECRET = "test-secret"
const DEFAULT_TTL_SECONDS = 604_800
const DEFAULT_USER_ID = 42
const DISCOVERY_PATH = "/.well-known/oauth-authorization-server"
const EPHEMERAL_PORT = 0
const GRAPHQL_PATH = "/v1/graphql"

const DEFAULT_USER: MockUser = { id: DEFAULT_USER_ID, librarian_roles: [], name: "Test Reader", pro: false, username: "reader" }

interface MockOptions {
  readonly accessTokenTtlSeconds?: number | undefined
  readonly clientId?: string | undefined
  readonly clientSecret?: string | undefined
  readonly graphql?: Readonly<Record<string, GraphHandler>> | undefined
  readonly port?: number | undefined
  readonly user?: MockUser | undefined
}

interface MockHardcover {
  readonly calls: ReadonlyArray<GraphCall>
  readonly expireAccessTokens: () => void
  readonly revokeAll: () => void
  readonly stop: () => void
  readonly tokenRequests: ReadonlyArray<Readonly<Record<string, string>>>
  readonly url: string
}

interface MockState {
  readonly calls: RecordedCalls
  readonly clientId: string
  readonly clientSecret: string
  readonly handlers: Readonly<Record<string, GraphHandler>>
  readonly store: ReturnType<typeof makeStore>
  readonly tokenRequests: RecordedRequests
  readonly user: MockUser
}

const recordedCalls = (): { readonly list: Array<GraphCall>; readonly recorded: RecordedCalls } => {
  const list: Array<GraphCall> = []
  return {
    list,
    recorded: {
      append: (call) => {
        list.push(call)
      },
    },
  }
}

const recordedRequests = (): { readonly list: Array<Record<string, string>>; readonly recorded: RecordedRequests } => {
  const list: Array<Record<string, string>> = []
  return {
    list,
    recorded: {
      append: (form) => {
        list.push(form)
      },
    },
  }
}

const stateFor = (
  options: MockOptions,
): { readonly exposed: MockState; readonly calls: Array<GraphCall>; readonly tokenRequests: Array<Record<string, string>> } => {
  const calls = recordedCalls()
  const tokenRequests = recordedRequests()
  return {
    calls: calls.list,
    exposed: {
      calls: calls.recorded,
      clientId: options.clientId ?? DEFAULT_CLIENT_ID,
      clientSecret: options.clientSecret ?? DEFAULT_CLIENT_SECRET,
      handlers: options.graphql ?? {},
      store: makeStore(options.accessTokenTtlSeconds ?? DEFAULT_TTL_SECONDS),
      tokenRequests: tokenRequests.recorded,
      user: options.user ?? DEFAULT_USER,
    },
    tokenRequests: tokenRequests.list,
  }
}

const publicRoute = (options: Readonly<{ issuer: string; pathname: string; state: MockState; url: URL }>): Response =>
  options.pathname === DISCOVERY_PATH
    ? discovery(options.issuer)
    : authorize({ clientId: options.state.clientId, issuer: options.issuer, store: options.state.store, url: options.url })

const tokenRoute = (options: Readonly<{ path: string; request: Request; state: MockState }>): Effect.Effect<Response> => {
  const { state } = options
  if (
    !authenticated({ clientId: state.clientId, clientSecret: state.clientSecret, header: options.request.headers.get("authorization") })
  ) {
    return Effect.succeed(json({ body: { error: "invalid_client" }, status: UNAUTHORIZED }))
  }
  return formFields(options.request).pipe(
    Effect.flatMap((form) => token({ form, path: options.path, requests: state.tokenRequests, store: state.store })),
  )
}

const routeOf = (options: Readonly<{ issuer: string; request: Request; state: MockState }>): Effect.Effect<Response> => {
  const url = new URL(options.request.url)
  if (url.pathname === DISCOVERY_PATH || url.pathname === AUTHORIZE_PATH) {
    return Effect.sync(() => publicRoute({ issuer: options.issuer, pathname: url.pathname, state: options.state, url }))
  }
  if (url.pathname === TOKEN_PATH || url.pathname === REVOKE_PATH) {
    return tokenRoute({ path: url.pathname, request: options.request, state: options.state })
  }
  if (url.pathname === GRAPHQL_PATH) {
    const { state } = options
    return answerGraphql({
      accessTokens: state.store.accessTokens,
      calls: state.calls,
      handlers: state.handlers,
      request: options.request,
      user: state.user,
    })
  }
  return Effect.succeed(text({ body: "not found", status: NOT_FOUND }))
}

const respond =
  (issuer: () => string, state: MockState): ((request: Request) => Promise<Response>) =>
  (request) =>
    Effect.runPromise(routeOf({ issuer: issuer(), request, state }))

const started = (options: MockOptions): MockHardcover => {
  const built = stateFor(options)
  const state = built.exposed
  let issuer = ""
  const server = Bun.serve({
    fetch: respond(() => issuer, state),
    port: options.port ?? EPHEMERAL_PORT,
  })
  issuer = `http://localhost:${server.port}`
  return {
    calls: built.calls,
    expireAccessTokens: (): void => {
      state.store.accessTokens.clear()
    },
    revokeAll: (): void => {
      state.store.accessTokens.clear()
      state.store.refreshTokens.clear()
    },
    stop: (): void => {
      server.stop(true).catch(() => issuer)
    },
    tokenRequests: built.tokenRequests,
    url: issuer,
  }
}

/**
 * Starts the mock and returns its URL plus the calls it recorded.
 * @param {MockOptions} options Optional port, credentials, user, and GraphQL handlers.
 * @returns {MockHardcover} The running mock. `stop` closes it.
 */
const startMockHardcover = (options: MockOptions = {}): MockHardcover => started(options)

/**
 * Application module, not a public API.
 * @internal
 */
export { startMockHardcover }

/**
 * Application module, not a public API.
 * @internal
 */
export type { MockHardcover }
