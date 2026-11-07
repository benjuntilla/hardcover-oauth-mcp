/**
 * The `hardcover_me` tool: who the connection belongs to.
 */
import { Effect, Option, Schema } from "effect"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"
import { Tool } from "effect/ai"
import { call } from "#src/mcp/tools/common.ts"
import { hardcoverTool } from "#src/mcp/define.ts"

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

const profileHandlers = {
  hardcover_me: Effect.fn(function* hardcoverMe() {
    const session = yield* Session
    const me = yield* call((hardcover) => hardcover.client.me.get({ refresh: true }))
    if (me.id !== session.hcUserId) {
      return yield* HardcoverError.make({ kind: "unavailable", message: "Hardcover returned a different account than this connection." })
    }
    return {
      grantedScopes: [...session.scopes],
      id: me.id,
      librarianRoles: session.librarianRoles,
      membership: me.pro ? "Supporter" : Option.getOrNull(Option.none()),
      name: me.name,
      supporter: me.pro,
      username: me.username ?? session.username,
    }
  }),
}

/**
 * Application module, not a public API.
 * @internal
 */
export { Me, profileHandlers }
