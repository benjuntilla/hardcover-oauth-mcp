/** The GraphQL request shape and the account lookup helpers. Documents are sent by `src/hardcover/transport.ts`. */
import { Array as Arr, Effect, Function, Option, Predicate, Record as Rec, Schema, pipe } from "effect"
import type { HardcoverAnswer, Reply } from "#src/hardcover/transport.ts"
import { Replies, runDocument } from "#src/hardcover/transport.ts"
import type { HardcoverEndpoints } from "#src/env.ts"
import type { HttpClient } from "effect/http"

const FIRST_ROW = 0
const NO_STATUS = 0
const HTTP_OK = 200
const HTTP_REDIRECT = 300
const HTTP_UNAUTHORIZED = 401
const HTTP_TOO_MANY = 429
const HTTP_SERVER_ERROR = 500
const ALLOWED_USER_ARITY = 2
const PARSE_ACCOUNT_ARITY = 2
const ACCOUNT_FIELDS = {
  basic: "id username name",
  roles: "id username name pro membership librarian_roles",
  supporter: "id username name pro membership",
} as const
const ALLOWED_SPLIT = /[\s,]+/v
const LEADING_AT = /^@/v
const EVERYONE = "*"

interface GraphQLRequest {
  readonly query: string
  readonly variables?: Readonly<Record<string, unknown>> | undefined
  readonly operationName?: string | undefined
}

interface Account {
  readonly id: number
  readonly username: string
  readonly name: string | null
  /** Supporter (paid) membership. */
  readonly supporter: boolean
  readonly membership: string | null
  /** `null` when the token can't read roles (no `read:me:roles`). */
  readonly librarianRoles: ReadonlyArray<string> | null
}

interface AccountQuery {
  readonly query: string
  readonly withRoles: boolean
}

const AccountData = Schema.Struct({ me: Schema.optionalKey(Schema.Array(Schema.Unknown)) })

const MeRow = Schema.Struct({
  id: Schema.Finite,
  librarian_roles: Schema.optionalKey(Schema.Unknown),
  membership: Schema.optionalKey(Schema.Unknown),
  name: Schema.optionalKey(Schema.Unknown),
  pro: Schema.optionalKey(Schema.Unknown),
  username: Schema.String,
})

const AnswerBody = Schema.Struct({ data: Schema.optionalKey(Schema.Unknown), errors: Schema.optionalKey(Schema.Unknown) })

/**
 * Librarian roles from Hardcover's jsonb: a list of names, or an object of flags.
 * @param {unknown} value The `librarian_roles` value.
 * @returns {ReadonlyArray<string>} The role names.
 */
const parseLibrarianRoles = (value: unknown): ReadonlyArray<string> => {
  if (Arr.isArray(value)) {
    return pipe(value, Arr.filter(Predicate.isString))
  }
  if (Predicate.isObject(value)) {
    return pipe(
      Rec.toEntries(value),
      Arr.filter(([, enabled]) => enabled === true),
      Arr.map(([role]) => role),
    )
  }
  return []
}

/**
 * An account query selecting the given fields.
 * @param {string} selected The field selection.
 * @returns {string} The query document.
 */
const accountQuery = (selected: string): string => `query HardcoverMcpAccount { me { ${selected} } }`

/**
 * Account queries from most to least detailed. Whether `read:me:content` alone
 * may read `pro` and `membership` isn't documented, so callers fall back down the list.
 * @param {boolean} withRoles Whether the token may read librarian roles.
 * @returns {ReadonlyArray<AccountQuery>} The queries to try, in order.
 */
const accountQueries = (withRoles: boolean): ReadonlyArray<AccountQuery> => {
  const detailed: ReadonlyArray<AccountQuery> = withRoles ? [{ query: accountQuery(ACCOUNT_FIELDS.roles), withRoles: true }] : []
  return [
    ...detailed,
    { query: accountQuery(ACCOUNT_FIELDS.supporter), withRoles: false },
    { query: accountQuery(ACCOUNT_FIELDS.basic), withRoles: false },
  ]
}

/**
 * A string field, or null when Hardcover sent something else.
 * @param {unknown} value The field.
 * @returns {string | null} The string, or null.
 */
const stringOrNull = (value: unknown): string | null => (Predicate.isString(value) ? value : Option.getOrNull(Option.none()))

/**
 * The signed-in account in an account query's `data`.
 * @param {unknown} data The response `data`.
 * @param {boolean} withRoles Whether librarian roles were requested.
 * @returns {Option.Option<Account>} The account, or none when the first row isn't one.
 */
const parseAccount: {
  (withRoles: boolean): (data: unknown) => Option.Option<Account>
  (data: unknown, withRoles: boolean): Option.Option<Account>
} = Function.dual(PARSE_ACCOUNT_ARITY, (data: unknown, withRoles: boolean): Option.Option<Account> =>
  pipe(
    Schema.decodeUnknownOption(AccountData)(data),
    Option.flatMap((decoded) => Arr.get(decoded.me ?? [], FIRST_ROW)),
    Option.flatMap(Schema.decodeUnknownOption(MeRow)),
    Option.map((row) => ({
      id: row.id,
      librarianRoles: withRoles ? parseLibrarianRoles(row.librarian_roles) : Option.getOrNull(Option.none()),
      membership: stringOrNull(row.membership),
      name: stringOrNull(row.name),
      supporter: row.pro === true,
      username: row.username,
    })),
  ),
)

/**
 * The account in an HTTP answer that wasn't GraphQL `data`: only a 2xx without errors can hold one.
 * @param {HardcoverAnswer} answer The answer.
 * @param {boolean} withRoles Whether librarian roles were requested.
 * @returns {Option.Option<Account>} The account.
 */
const answeredAccount = (answer: HardcoverAnswer, withRoles: boolean): Option.Option<Account> => {
  const body = pipe(answer.body, Option.flatMap(Schema.decodeUnknownOption(AnswerBody)))
  const succeeded = answer.status >= HTTP_OK && answer.status < HTTP_REDIRECT
  const failed = pipe(
    body,
    Option.exists((fields) => Predicate.isTruthy(fields.errors)),
  )
  if (!succeeded || failed) {
    return Option.none()
  }
  return pipe(
    body,
    Option.flatMap((fields) => parseAccount(fields.data, withRoles)),
  )
}

/**
 * The account in one reply, with the status it came with.
 * @param {Reply} reply What Hardcover replied.
 * @param {boolean} withRoles Whether librarian roles were requested.
 * @returns {Effect.Effect<{ readonly account: Option.Option<Account>; readonly status: number }>} The account and status. No answer at all is a defect, as a failed `fetch` always was here.
 */
const replyAccount = (
  reply: Reply,
  withRoles: boolean,
): Effect.Effect<{ readonly account: Option.Option<Account>; readonly status: number }> =>
  Replies.$match(reply, {
    Answered: ({ answer }) => Effect.succeed({ account: answeredAccount(answer, withRoles), status: answer.status }),
    Data: ({ data }) => Effect.succeed({ account: parseAccount(data, withRoles), status: HTTP_OK }),
    Unreachable: ({ timedOut }) => Effect.die(new Error(timedOut ? "Hardcover did not answer in time" : "Could not reach Hardcover")),
  })

/**
 * Whether a status means the narrower queries would fail too.
 * @param {number} status The HTTP status.
 * @returns {boolean} Whether to stop trying.
 */
const hopeless = (status: number): boolean => status === HTTP_UNAUTHORIZED || status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR

interface AccountLookup {
  readonly accessToken: string
  readonly endpoints: HardcoverEndpoints
}

/**
 * The first account the remaining queries return.
 * @param {AccountLookup} lookup The token and the endpoint.
 * @param {ReadonlyArray<AccountQuery>} remaining The queries left to try.
 * @param {number} status The last HTTP status, for the defect report.
 * @returns {Effect.Effect<Account, never, HttpClient.HttpClient>} The account.
 */
const firstAccount = (
  lookup: AccountLookup,
  remaining: ReadonlyArray<AccountQuery>,
  status: number,
): Effect.Effect<Account, never, HttpClient.HttpClient> =>
  Arr.matchLeft(remaining, {
    onEmpty: () => Effect.die(new Error(`Hardcover did not return the signed-in user (HTTP ${status})`)),
    onNonEmpty: (attempt, rest) =>
      Effect.gen(function* tryAccount() {
        const document = {
          accessToken: lookup.accessToken,
          mutation: false,
          request: { query: attempt.query },
          url: lookup.endpoints.graphqlUrl,
        }
        const found = yield* Effect.flatMap(runDocument(document), (reply) => replyAccount(reply, attempt.withRoles))
        if (Option.isSome(found.account)) {
          return found.account.value
        }
        return yield* firstAccount(lookup, hopeless(found.status) ? [] : rest, found.status)
      }),
  })

/**
 * The signed-in account, used once during authorization.
 * @param {object} options The token from the code exchange and what it may read.
 * @param {string} options.accessToken The access token.
 * @param {HardcoverEndpoints} options.endpoints Hardcover's endpoints.
 * @param {boolean} options.withRoles Whether the token may read librarian roles.
 * @returns {Effect.Effect<Account, never, HttpClient.HttpClient>} The account. Not finding it is a defect.
 */
const fetchAccount = (options: {
  readonly accessToken: string
  readonly endpoints: HardcoverEndpoints
  readonly withRoles: boolean
}): Effect.Effect<Account, never, HttpClient.HttpClient> => firstAccount(options, accountQueries(options.withRoles), NO_STATUS)

/**
 * One allowlist entry, lower-cased and without a leading `@`, or none when blank.
 * @param {string} entry The raw entry.
 * @returns {Option.Option<string>} The normalized entry.
 */
const normalizeEntry = (entry: string): Option.Option<string> => {
  const trimmed = entry.trim().replace(LEADING_AT, "").toLowerCase()
  return trimmed === "" ? Option.none() : Option.some(trimmed)
}

/**
 * `ALLOWED_HARDCOVER_USERS`: usernames or numeric ids separated by commas or spaces; `*` allows everyone.
 * @param {string} setting The allowlist setting.
 * @param {Readonly<{ id: number; username: string }>} user The account to check.
 * @returns {boolean} Whether the account may use this server.
 */
const isAllowedUser: {
  (user: Readonly<{ id: number; username: string }>): (setting: string) => boolean
  (setting: string, user: Readonly<{ id: number; username: string }>): boolean
} = Function.dual(ALLOWED_USER_ARITY, (setting: string, user: Readonly<{ id: number; username: string }>): boolean => {
  const entries = pipe(setting.split(ALLOWED_SPLIT), Arr.map(normalizeEntry), Arr.getSomes)
  return (
    pipe(entries, Arr.contains(EVERYONE)) ||
    pipe(entries, Arr.contains(user.username.toLowerCase())) ||
    pipe(entries, Arr.contains(String(user.id)))
  )
})

/**
 * Application module, not a public API.
 * @internal
 */
export { accountQueries, fetchAccount, isAllowedUser, parseAccount }
/**
 * Application module, not a public API.
 * @internal
 */
export type { GraphQLRequest }
