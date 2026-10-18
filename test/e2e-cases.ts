/**
 * End-to-end cases up to the static pages: discovery, authorization, the
 * 2026-07-28 transport, and 2025-06-18 sessions.
 */
import { Array as Arr, Effect, Option, Schema, String as Str, pipe } from "effect"
import { BASE, Mock } from "#test/e2e-setup.ts"
import type { HttpClient, HttpClientResponse } from "effect/http"
import { currentSession, remember } from "#test/e2e-session.ts"
import { decodeJson, get, post, textBody } from "#test/client-http.ts"
import { legacyMcp, mcp, rpcMessage } from "#test/client-mcp.ts"
import type { CaseError } from "#test/e2e-setup.ts"
import { approved } from "#test/oauth-client.ts"
import { expect } from "bun:test"

const ACCEPTED = 202
const LEGACY_PROTOCOL = "2025-06-18"
const MINIMUM_TOOLS = 3
const NO_CONTENT = 204
const NOT_FOUND = 404
const OK = 200
const UNAUTHORIZED = 401

const Discovery = Schema.Struct({ authorization_endpoint: Schema.String, scopes_supported: Schema.Array(Schema.String) })
const ProtectedResource = Schema.Struct({ resource: Schema.String })
const Tool = Schema.Struct({ name: Schema.String })
const ToolList = Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Tool) }) })
const Me = Schema.Struct({ username: Schema.String })
const MeCall = Schema.Struct({ result: Schema.Struct({ isError: Schema.Boolean, structuredContent: Me }) })
const Initialized = Schema.Struct({ result: Schema.Struct({ protocolVersion: Schema.String }) })
const Book = Schema.Struct({ books_by_pk: Schema.Struct({ title: Schema.String }) })
const BookCall = Schema.Struct({ result: Schema.Struct({ structuredContent: Schema.Struct({ data: Book }) }) })

const namesOf = (list: typeof ToolList.Type): ReadonlyArray<string> =>
  pipe(
    list.result.tools,
    Arr.map((tool) => tool.name),
  )

/**
 * The tool names in a 2026-07-28 `tools/list` response.
 * @param {HttpClientResponse.HttpClientResponse} response The `tools/list` response.
 * @returns {Effect.Effect<ReadonlyArray<string>, CaseError>} The names.
 */
const toolNames = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<ReadonlyArray<string>, CaseError> =>
  decodeJson({ response, schema: ToolList }).pipe(Effect.map(namesOf))

const discovery = Effect.gen(function* publishDiscovery() {
  const metadata = yield* get({ url: `${BASE}/.well-known/oauth-authorization-server` })
  const server = yield* decodeJson({ response: metadata, schema: Discovery })
  expect(server.authorization_endpoint).toBe(`${BASE}/authorize`)
  expect(server.scopes_supported).toContain("write:goals")
  const protectedResource = yield* get({ url: `${BASE}/.well-known/oauth-protected-resource/mcp` })
  expect((yield* decodeJson({ response: protectedResource, schema: ProtectedResource })).resource).toBe(`${BASE}/mcp`)
  const unauthenticated = yield* post({ body: textBody({ text: "{}", type: "text/plain;charset=UTF-8" }), url: `${BASE}/mcp` })
  expect(unauthenticated.status).toBe(UNAUTHORIZED)
  expect(unauthenticated.headers["www-authenticate"]).toContain("resource_metadata=")
})

const expectGrantedScopes = (scope: string): void => {
  const scopes = pipe(scope, Str.split(" "))
  expect(scopes).toContain("write:library")
  // Catalog editing is opt-in and dropped for non-librarians anyway.
  expect(scopes).not.toContain("write:catalog:edit")
  // Openid and offline_access are between this server and Hardcover only.
  expect(scopes).not.toContain("offline_access")
  expect(scopes).not.toContain("openid")
}

const authorization = Effect.gen(function* authorizeThroughConsent() {
  const result = yield* approved({ base: BASE })
  yield* remember(result)
  expect(result.consentHtml).toContain("E2E Client")
  expectGrantedScopes(result.tokens.scope)
  // Hardcover saw PKCE and our client credentials.
  const lastTokenRequest = Arr.last((yield* Mock).tokenRequests)
  const verifier = pipe(
    lastTokenRequest,
    Option.flatMapNullishOr((request) => request.code_verifier),
    Option.getOrUndefined,
  )
  expect(verifier).toBeString()
  // The provider prefixes tokens with the user id it files the grant under: a pseudonym, not the Hardcover id.
  const tokenUser = pipe(result.tokens.access_token, Str.split(":"), Arr.headNonEmpty)
  expect(tokenUser).toMatch(/^[0-9a-f]{32}$/v)
})

const toolsOverCurrentProtocol = Effect.gen(function* listAndCall() {
  const session = yield* currentSession
  const list = yield* mcp({ base: BASE, method: "tools/list", token: session.tokens.access_token })
  expect(list.status).toBe(OK)
  const tools = yield* toolNames(list)
  expect(tools).toContain("hardcover_me")
  expect(tools).toContain("hardcover_query")
  const call = yield* mcp({
    base: BASE,
    method: "tools/call",
    params: { arguments: {}, name: "hardcover_me" },
    token: session.tokens.access_token,
  })
  const { result } = yield* decodeJson({ response: call, schema: MeCall })
  expect(result.isError).toBe(false)
  expect(result.structuredContent.username).toBe("reader")
})

const legacyInitialize = (token: string): Effect.Effect<Readonly<Record<string, string>>, CaseError, HttpClient.HttpClient> =>
  Effect.gen(function* initializeLegacy() {
    const init = yield* legacyMcp({
      base: BASE,
      body: {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { capabilities: {}, clientInfo: { name: "old", version: "1" }, protocolVersion: LEGACY_PROTOCOL },
      },
      token,
    })
    expect(init.status).toBe(OK)
    const sessionId = init.headers["mcp-session-id"]
    expect(sessionId).toBeString()
    const initialized = yield* rpcMessage(init).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Initialized)))
    expect(initialized.result.protocolVersion).toBe(LEGACY_PROTOCOL)
    return { "mcp-protocol-version": LEGACY_PROTOCOL, "mcp-session-id": sessionId ?? "" }
  })

const legacyCalls = (
  options: Readonly<{ inSession: Readonly<Record<string, string>>; token: string }>,
): Effect.Effect<void, CaseError, HttpClient.HttpClient> =>
  Effect.gen(function* callInSession() {
    const { inSession, token } = options
    const notified = yield* legacyMcp({
      base: BASE,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
      headers: inSession,
      token,
    })
    expect(notified.status).toBe(ACCEPTED)
    const list = yield* legacyMcp({ base: BASE, body: { id: 2, jsonrpc: "2.0", method: "tools/list" }, headers: inSession, token })
    const listed = yield* rpcMessage(list).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ToolList)))
    expect(listed.result.tools.length).toBeGreaterThan(MINIMUM_TOOLS)
    const call = yield* legacyMcp({
      base: BASE,
      body: {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { query: "query { books_by_pk(id: 100) { id title } }" }, name: "hardcover_query" },
      },
      headers: inSession,
      token,
    })
    const called = yield* rpcMessage(call).pipe(Effect.flatMap(Schema.decodeUnknownEffect(BookCall)))
    expect(called.result.structuredContent.data.books_by_pk.title).toBe("Dune")
  })

const legacySession = Effect.gen(function* serveLegacySession() {
  const token = (yield* currentSession).tokens.access_token
  const inSession = yield* legacyInitialize(token)
  yield* legacyCalls({ inSession, token })
  const ended = yield* legacyMcp({ base: BASE, headers: inSession, method: "DELETE", token })
  expect(ended.status).toBe(NO_CONTENT)
  const afterEnd = yield* legacyMcp({ base: BASE, body: { id: 4, jsonrpc: "2.0", method: "tools/list" }, headers: inSession, token })
  expect(afterEnd.status).toBe(NOT_FOUND)
})

const page = (path: string): Effect.Effect<string, CaseError, HttpClient.HttpClient> =>
  Effect.gen(function* servePage() {
    const response = yield* get({ url: `${BASE}${path}` })
    expect(response.status).toBe(OK)
    return yield* response.text
  })

const staticPages = Effect.gen(function* serveStaticPages() {
  expect(yield* page("/")).toContain("hardcover_set_status")
  expect(yield* page("/privacy")).toContain("Data collected")
  expect(yield* page("/terms")).toContain("No warranty")
  expect(yield* page("/security")).toContain("Reporting a vulnerability")
  const css = yield* get({ url: `${BASE}/site.css` })
  expect(css.headers["content-type"]).toContain("text/css")
  const { consentHtml } = yield* currentSession
  expect(consentHtml).toContain('href="/site.css"')
  expect(consentHtml).toContain('href="/privacy"')
  expect(consentHtml).toContain('href="/terms"')
})

/**
 * Application module, not a public API.
 * @internal
 */
export { authorization, discovery, legacySession, staticPages, toolNames, toolsOverCurrentProtocol }
