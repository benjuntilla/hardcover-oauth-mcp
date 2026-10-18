/**
 * Unit tests: the query guard, the GraphQL executor against a scripted
 * endpoint, scope handling, the user allowlist, and the README tool table.
 */
import { Array as Arr, Effect, Exit, Option, Schema, pipe } from "effect"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { inspect, missingScopes } from "#src/hardcover/guard.ts"
import { installScriptedFetch, run } from "#test/unit-executor.ts"
import { normalizeScopes, scopesForRoles } from "#src/hardcover/scopes.ts"
import type { Inspection } from "#src/hardcover/guard.ts"
import type { TokenResult } from "#test/unit-executor.ts"
import { isAllowedUser } from "#src/hardcover/graphql.ts"
import { retryAfterSeconds } from "#src/hardcover/client.ts"
import { toolsTable } from "#src/docs/tools-table.ts"

const OK = 200
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const TOO_MANY_REQUESTS = 429
const UNAVAILABLE = 503
const ONE_REQUEST = 1
const DAILY_WAIT_SECONDS = 5000
const RETRY_AFTER_SECONDS = 7
/** One more than the guard allows. */
const TOO_MANY_FIELDS = 11
const FIRST_ID = 1

const README = new URL("../README.md", import.meta.url)
const TOOLS_TABLE = /<!-- tools:start[^>]*-->\n(?<table>[\s\S]*?)\n<!-- tools:end -->/v

/** The options `inspect` takes, spelled out so the tests only rely on its call shape. */
type GuardOptions = Readonly<{ expect: "mutation" | "query"; variables?: unknown }>

const QUERY: GuardOptions = { expect: "query" }
const MUTATION: GuardOptions = { expect: "mutation" }
const DATA = { body: { data: { me: [] } }, status: OK }
const UNKNOWN_ROLES = Option.getOrNull(Option.none<ReadonlyArray<string>>())

class GuardSurprise extends Schema.TaggedError<GuardSurprise, { readonly brand: unique symbol }>()("GuardSurprise", {
  message: Schema.String,
}) {}

const accepted = (query: string, options: GuardOptions = QUERY): Effect.Effect<Inspection, GuardSurprise> => {
  const result = inspect(query, options)
  return result.ok ? Effect.succeed(result.inspection) : Effect.fail(GuardSurprise.make({ message: result.message }))
}

const rejected = (query: string, options: GuardOptions = QUERY): Effect.Effect<string, GuardSurprise> => {
  const result = inspect(query, options)
  return result.ok ? Effect.fail(GuardSurprise.make({ message: "expected a rejection" })) : Effect.succeed(result.message)
}

const readme = Effect.promise(() => Bun.file(README).text())

describe("guard", () => {
  test("rejects disabled operators in the document and in variables", () =>
    Effect.runPromise(
      Effect.gen(function* disabledOperators() {
        expect(yield* rejected('{ books(where: {title: {_ilike: "%x%"}}) { id } }')).toContain("_ilike")
        const variables = { where: { title: { _regex: "x" } } }
        const inVariables = yield* rejected("query($where: books_bool_exp) { books(where: $where) { id } }", { expect: "query", variables })
        expect(inVariables).toContain("_regex")
      }),
    ))

  test("counts top-level fields through fragments and caps them at 10", () =>
    Effect.runPromise(
      Effect.gen(function* topLevelFields() {
        const fields = Arr.makeBy(TOO_MANY_FIELDS, (index) => `b${index}: books_by_pk(id: ${index + FIRST_ID}) { id }`)
        const document = `{ ${pipe(fields, Arr.join(" "))} }`
        expect(yield* rejected(document)).toContain("11 top-level fields")
        const fragment = yield* accepted("query { ...F } fragment F on query_root { me { id } books_by_pk(id: 1) { id } }")
        expect(fragment.rootFields).toEqual(["me", "books_by_pk"])
      }),
    ))

  test("checks the operation kind and that root fields exist for tokens", () =>
    Effect.runPromise(
      Effect.gen(function* operationKind() {
        expect(yield* rejected("mutation { delete_goal(id: 1) { id } }")).toContain("hardcover_mutate")
        expect(yield* rejected("mutation { update_user(user: {}) { id } }", MUTATION)).toContain("not a mutation available")
      }),
    ))

  test("requires gated columns' and arguments' scopes", () =>
    Effect.runPromise(
      Effect.gen(function* gatedScopes() {
        const roles = yield* accepted("{ me { id librarian_roles } }")
        expect(missingScopes(roles, new Set(["read:me:content"]))).toEqual(["field librarian_roles needs read:me or read:me:roles"])
        const review = yield* accepted("mutation($object: UserBookUpdateInput!) { update_user_book(id: 1, object: $object) { id } }", {
          expect: "mutation",
          variables: { object: { review_markdown: "hi" } },
        })
        expect(missingScopes(review, new Set(["write:library"]))).toEqual(["argument review_markdown needs write:reviews"])
        expect(missingScopes(review, new Set(["write:library", "write:reviews"]))).toEqual([])
      }),
    ))
})

const refreshOnce = Effect.gen(function* refreshOnce() {
  const outcome = yield* run({ replies: [{ body: { error: "invalid_token" }, status: UNAUTHORIZED }, DATA] })
  expect(Exit.isSuccess(outcome.exit)).toBe(true)
  expect(outcome.seenTokens).toEqual(["Bearer t1", "Bearer t2"])
  expect(outcome.rejected).toEqual([Option.none(), Option.some("t1")])
})

const revokedConnection = Effect.gen(function* revokedConnection() {
  const tokens: ReadonlyArray<TokenResult> = [
    { ok: true, token: "t1" },
    { message: "gone", ok: false, reason: "revoked" },
  ]
  const outcome = yield* run({ replies: [{ body: {}, status: UNAUTHORIZED }], tokens })
  expect(outcome.kind).toBe("reauth")
})

const rateLimits = Effect.gen(function* rateLimits() {
  const short = yield* run({ replies: [{ body: {}, headers: { "retry-after": "1" }, status: TOO_MANY_REQUESTS }, DATA] })
  expect(Exit.isSuccess(short.exit)).toBe(true)
  const daily = yield* run({ replies: [{ body: {}, headers: { ratelimit: '"daily";r=0;t=3600' }, status: TOO_MANY_REQUESTS }] })
  expect(daily.message).toContain("daily API limit")
  expect(daily.seenTokens).toHaveLength(ONE_REQUEST)
})

const serverErrors = Effect.gen(function* serverErrors() {
  const query = yield* run({ replies: [{ body: {}, status: UNAVAILABLE }, DATA] })
  expect(Exit.isSuccess(query.exit)).toBe(true)
  const mutation = yield* run({
    mutation: true,
    replies: [
      { body: {}, status: UNAVAILABLE },
      { body: { data: {} }, status: OK },
    ],
  })
  expect(mutation.message).toContain("may or may not have been applied")
  expect(mutation.seenTokens).toHaveLength(ONE_REQUEST)
})

const advice = Effect.gen(function* advice() {
  const errors = [{ extensions: { code: "validation-failed" }, message: "field 'x' not found" }]
  const graphql = yield* run({ replies: [{ body: { errors }, status: OK }] })
  expect(graphql.message).toContain("field 'x' not found [validation-failed]")
  const scope = yield* run({ replies: [{ body: { error: "insufficient_scope", scope: "write:goals" }, status: FORBIDDEN }] })
  expect(scope.message).toContain("missing permission write:goals")
})

const missingData = Effect.gen(function* missingData() {
  const outcome = yield* run({ replies: [{ body: {}, status: OK }] })
  expect(Exit.hasDies(outcome.exit)).toBe(true)
})

describe("GraphQL executor", () => {
  beforeEach(() => {
    installScriptedFetch()
  })

  afterEach(() => {
    mock.restore()
  })

  test("refreshes once on 401, naming the rejected token", () => Effect.runPromise(refreshOnce))
  test("reports a revoked connection instead of looping", () => Effect.runPromise(revokedConnection))
  test("waits out a short rate limit, but not the daily one", () => Effect.runPromise(rateLimits))
  test("retries a 503 for queries only", () => Effect.runPromise(serverErrors))
  test("turns GraphQL errors and scope refusals into advice", () => Effect.runPromise(advice))
  test("treats a 200 without data as a defect, so it is reported rather than shown as a tool error", () => Effect.runPromise(missingData))

  test("reads the wait from RateLimit when Retry-After is absent", () => {
    expect(retryAfterSeconds(new Headers({ ratelimit: '"Free";r=0;t=42, "daily";r=10;t=5000' }))).toBe(DAILY_WAIT_SECONDS)
    expect(retryAfterSeconds(new Headers({ "retry-after": "7" }))).toBe(RETRY_AFTER_SECONDS)
  })
})

describe("scopes and access", () => {
  test("always grants the profile scope and drops unknown ones", () => {
    expect(normalizeScopes(["write:goals", "bogus", "read:goals"])).toEqual(["read:me:content", "read:goals", "write:goals"])
  })

  test("keeps catalog scopes only for matching librarian roles", () => {
    const asked = ["read:catalog", "write:catalog:append", "write:catalog:edit", "write:catalog:map"]
    expect(scopesForRoles(asked, [])).toEqual(["read:catalog", "write:catalog:append"])
    expect(scopesForRoles(asked, ["appender"])).toEqual(["read:catalog", "write:catalog:append"])
    expect(scopesForRoles(asked, ["librarian"])).toEqual(["read:catalog", "write:catalog:append", "write:catalog:edit"])
    expect(scopesForRoles(asked, ["hardcover_admin"])).toEqual(asked)
    expect(scopesForRoles(asked, UNKNOWN_ROLES)).toEqual(asked)
  })

  test("matches the allowlist by username or id, case-insensitively", () => {
    const user = { id: 42, username: "Reader" }
    expect(isAllowedUser("", user)).toBe(false)
    expect(isAllowedUser("someone, @reader", user)).toBe(true)
    expect(isAllowedUser("7 42", user)).toBe(true)
    expect(isAllowedUser("*", user)).toBe(true)
    expect(isAllowedUser("readers", user)).toBe(false)
  })
})

describe("docs", () => {
  test("the README tool table matches the toolkit (run `mise run docs:tools`)", () =>
    Effect.runPromise(
      Effect.gen(function* toolTable() {
        const text = yield* readme
        expect(TOOLS_TABLE.exec(text)?.groups?.table).toBe(toolsTable())
      }),
    ))
})
