/**
 * A connection's storage and tokens against a scripted Hardcover token
 * endpoint: a refused refresh erases the connection, a refresh keeps what
 * happened to the connection while Hardcover answered, and a connection an
 * earlier deployment marked revoked is erased as soon as it is read.
 */
import { Effect, Option, Struct } from "effect"
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { ConnectionState } from "#src/connection/state.ts"
import { ConnectionStore } from "#src/connection/storage.ts"
import { REVOKED_MESSAGE } from "#src/connection/state.ts"
import type { Storage } from "#src/connection/storage.ts"
import { platform } from "#src/platform.ts"
import { refreshConnection } from "#src/connection/tokens.ts"

const ISSUER = "https://connection.test"
const ENDPOINTS = { clientId: "client", clientSecret: "secret", graphqlUrl: `${ISSUER}/graphql`, issuer: ISSUER }
const METADATA = {
  authorization_endpoint: `${ISSUER}/authorize`,
  issuer: ISSUER,
  revocation_endpoint: `${ISSUER}/revoke`,
  token_endpoint: `${ISSUER}/token`,
}
const OK = 200
const BAD_REQUEST = 400
const UNAUTHORIZED = 401
const UNAVAILABLE = 503
const STATE_KEY = "state"
const ALARM_AT = 1_000_000
const NO_REQUESTS = 0
const ONE_REQUEST = 1

const STATE: ConnectionState = {
  accessToken: "a1",
  accessTokenExpiresAt: ALARM_AT,
  createdAt: ALARM_AT,
  hcUserId: 7,
  lastUsedAt: ALARM_AT,
  refreshToken: "r1",
  username: "reader",
}

interface TokenReply {
  readonly body: unknown
  readonly status: number
}

const nothing = (): Promise<void> => Promise.resolve()

/** What the token endpoint answers and does before answering, and the requests the scripted Hardcover received. */
const network: { token: TokenReply; duringToken: () => Promise<void>; tokenRequests: number; revocations: number } = {
  duringToken: nothing,
  revocations: NO_REQUESTS,
  token: { body: {}, status: OK },
  tokenRequests: NO_REQUESTS,
}

/** A Durable Object's storage in memory, with its alarm. */
interface FakeStorage {
  readonly storage: Storage
  readonly entries: Map<string, unknown>
  readonly alarm: { scheduled: Option.Option<number> }
}

const fakeStorage = (stored: unknown): FakeStorage => {
  const entries = new Map<string, unknown>([[STATE_KEY, structuredClone(stored)]])
  const alarm = { scheduled: Option.some(ALARM_AT) }
  const storage: Storage = {
    deleteAlarm: () => {
      alarm.scheduled = Option.none()
      return Promise.resolve()
    },
    deleteAll: () => {
      entries.clear()
      return Promise.resolve()
    },
    get: (key) => Promise.resolve(structuredClone(entries.get(key))),
    put: (key, value) => {
      entries.set(key, structuredClone(value))
      return Promise.resolve()
    },
    setAlarm: (scheduledTime) => {
      alarm.scheduled = Option.some(scheduledTime)
      return Promise.resolve()
    },
  }
  return { alarm, entries, storage }
}

const urlOf = (input: RequestInfo | URL): string => (input instanceof Request ? input.url : input.toString())

const scriptedFetch: typeof fetch = Object.assign(
  (input: RequestInfo | URL): Promise<Response> => {
    const url = urlOf(input)
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Promise.resolve(Response.json(METADATA))
    }
    if (url.endsWith("/token")) {
      network.tokenRequests += ONE_REQUEST
      return network.duringToken().then(() => Response.json(network.token.body, { status: network.token.status }))
    }
    network.revocations += ONE_REQUEST
    return Promise.resolve(Response.json({}))
  },
  { preconnect: globalThis.fetch.preconnect },
)

const refusedRefresh = Effect.gen(function* refusedRefresh() {
  network.token = { body: { error: "invalid_grant", error_description: "refresh token already used" }, status: BAD_REQUEST }
  const fake = fakeStorage(STATE)
  const result = yield* refreshConnection({ endpoints: ENDPOINTS, store: new ConnectionStore(fake.storage) })
  expect(result).toEqual({ message: REVOKED_MESSAGE, ok: false, reason: "revoked" })
  expect([...fake.entries.keys()]).toEqual([])
  expect(fake.alarm.scheduled).toEqual(Option.none())
  // The token is dead already, so nothing is revoked at Hardcover; a later read finds no connection.
  expect(network.revocations).toBe(NO_REQUESTS)
  expect(yield* new ConnectionStore(fake.storage).load()).toEqual(Option.none())
})

const unavailableRefresh = Effect.gen(function* unavailableRefresh() {
  network.token = { body: {}, status: UNAVAILABLE }
  const fake = fakeStorage(STATE)
  const result = yield* refreshConnection({ endpoints: ENDPOINTS, store: new ConnectionStore(fake.storage) })
  expect(result).toEqual({
    message: "Could not refresh the Hardcover session (Hardcover OAuth temporarily_unavailable: HTTP 503). Try again shortly.",
    ok: false,
    reason: "unavailable",
  })
  expect(fake.entries.get(STATE_KEY)).toEqual(STATE)
  expect(network.tokenRequests).toBe(ONE_REQUEST)
})

const misconfiguredRefresh = Effect.gen(function* misconfiguredRefresh() {
  network.token = { body: { error: "invalid_client" }, status: UNAUTHORIZED }
  const fake = fakeStorage(STATE)
  const result = yield* refreshConnection({ endpoints: ENDPOINTS, store: new ConnectionStore(fake.storage) })
  expect(result).toMatchObject({ ok: false, reason: "unavailable" })
  expect(fake.entries.get(STATE_KEY)).toEqual(STATE)
})

const rotatedRefresh = Effect.gen(function* rotatedRefresh() {
  network.token = { body: { access_token: "a2", expires_in: 3600, refresh_token: "r2" }, status: OK }
  const fake = fakeStorage(STATE)
  const result = yield* refreshConnection({ endpoints: ENDPOINTS, store: new ConnectionStore(fake.storage) })
  expect(result).toEqual({ ok: true, token: "a2" })
  expect(fake.entries.get(STATE_KEY)).toMatchObject({ accessToken: "a2", refreshToken: "r2" })
})

const useDuringRefresh = Effect.gen(function* useDuringRefresh() {
  network.token = { body: { access_token: "a2", expires_in: 3600, refresh_token: "r2" }, status: OK }
  const fake = fakeStorage(STATE)
  const store = new ConnectionStore(fake.storage)
  network.duringToken = (): Promise<void> => platform.runPromise(store.touch())
  yield* refreshConnection({ endpoints: ENDPOINTS, store })
  expect(fake.entries.get(STATE_KEY)).toMatchObject({ accessToken: "a2", refreshToken: "r2" })
  expect(fake.entries.get(STATE_KEY)).not.toMatchObject({ lastUsedAt: ALARM_AT })
})

const eraseDuringRefresh = Effect.gen(function* eraseDuringRefresh() {
  network.token = { body: { access_token: "a2", expires_in: 3600, refresh_token: "r2" }, status: OK }
  const fake = fakeStorage(STATE)
  const store = new ConnectionStore(fake.storage)
  network.duringToken = (): Promise<void> => platform.runPromise(store.forget())
  const result = yield* refreshConnection({ endpoints: ENDPOINTS, store })
  expect(result).toEqual({ message: REVOKED_MESSAGE, ok: false, reason: "revoked" })
  expect([...fake.entries.keys()]).toEqual([])
  expect(network.revocations).toBe(ONE_REQUEST)
})

const legacyRevoked = Effect.gen(function* legacyRevoked() {
  const fake = fakeStorage(Struct.assign(STATE, { revoked: "invalid_grant: refresh token already used" }))
  expect(yield* new ConnectionStore(fake.storage).load()).toEqual(Option.none())
  expect([...fake.entries.keys()]).toEqual([])
  expect(fake.alarm.scheduled).toEqual(Option.none())
})

describe("connection tokens", () => {
  beforeEach(() => {
    network.tokenRequests = NO_REQUESTS
    network.revocations = NO_REQUESTS
    network.duringToken = nothing
    spyOn(globalThis, "fetch").mockImplementation(scriptedFetch)
  })

  afterEach(() => {
    mock.restore()
  })

  test("a refused refresh erases the connection and still reports it revoked", () => platform.runPromise(refusedRefresh))

  test("a refresh Hardcover can't answer keeps the connection", () => platform.runPromise(unavailableRefresh))

  test("a refresh refused for the server's own credentials keeps the connection", () => platform.runPromise(misconfiguredRefresh))

  test("a rotated token set is stored before it is handed out", () => platform.runPromise(rotatedRefresh))

  test("a use recorded while Hardcover rotates the tokens is kept", () => platform.runPromise(useDuringRefresh))

  test("a connection erased while Hardcover rotates the tokens stays erased", () => platform.runPromise(eraseDuringRefresh))

  test("a connection an earlier deployment marked revoked is erased when read", () => Effect.runPromise(legacyRevoked))
})
