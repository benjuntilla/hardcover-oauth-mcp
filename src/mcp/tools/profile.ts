/**
 * The `hardcover_me` tool: who the connection belongs to.
 */
import { Array as Arr, Effect, Option, Schema } from "effect"
import { accountQueries, parseAccount } from "#src/hardcover/graphql.ts"
import { GraphQL } from "effect/graphql"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"
import { Tool } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"
import { run } from "#src/mcp/tools/common.ts"

const MeData = Schema.Unknown

const librarianRoles = Schema.NullOr(Schema.Array(Schema.String)).annotate({
  description: "null when this connection may not read roles (read:me:roles not granted).",
})

const Me = hardcoverTool({
  description:
    "Returns the connected Hardcover account: id, username, name, Supporter (paid) membership, librarian roles, and the " +
    "scopes this connection was granted. Use the id as user_id in other queries.",
  kind: "read",
  name: "hardcover_me",
  parameters: Tool.EmptyParams,
  scopes: ["read:me:content"],
  success: Schema.Struct({
    grantedScopes: Schema.Array(Schema.String),
    id: Schema.Int,
    librarianRoles,
    membership: Schema.NullOr(Schema.String),
    name: Schema.NullOr(Schema.String),
    supporter: Schema.Boolean,
    username: Schema.String,
  }),
  title: "Get your Hardcover profile",
})

type AccountQueries = ReturnType<typeof accountQueries>
type FoundAccount = ReturnType<typeof parseAccount>

/**
 * The account from the first query that returns it. A query this connection may not
 * read fails as a whole, so a refused one is retried with fewer fields, unless it was the last.
 * @param {AccountQueries} attempts The queries left, from most to least detailed.
 * @returns {Effect.Effect<FoundAccount, HardcoverError, Session>} The account, or none when no query returned it.
 */
const firstAccount = (attempts: AccountQueries): Effect.Effect<FoundAccount, HardcoverError, Session> =>
  Arr.matchLeft(attempts, {
    onEmpty: () => Effect.succeedNone,
    onNonEmpty: (attempt, rest) =>
      run(GraphQL.query("HardcoverMcpAccount", { document: attempt.query, result: MeData }))({}).pipe(
        Effect.map(parseAccount(attempt.withRoles)),
        Effect.catchIf(
          (error) => (error.kind === "invalid" || error.kind === "forbidden") && Arr.isReadonlyArrayNonEmpty(rest),
          () => Effect.succeedNone,
        ),
        Effect.filterOrElse(Option.isSome, () => firstAccount(rest)),
      ),
  })

const profileHandlers = {
  hardcover_me: Effect.fn(function* hardcoverMe() {
    const session = yield* Session
    const account = yield* firstAccount(accountQueries(session.scopes.has("read:me:roles")))
    if (Option.isNone(account)) {
      return yield* HardcoverError.make({ kind: "unavailable", message: "Hardcover did not return the account." })
    }
    const found = account.value
    return {
      grantedScopes: [...session.scopes],
      id: found.id,
      librarianRoles: found.librarianRoles === null ? found.librarianRoles : [...found.librarianRoles],
      membership: found.membership,
      name: found.name,
      supporter: found.supporter,
      username: found.username,
    }
  }),
}

/**
 * Application module, not a public API.
 * @internal
 */
export { Me, profileHandlers }
