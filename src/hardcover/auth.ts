/**
 * The bearer token on Hardcover GraphQL calls, attached by `effect/graphql` middleware.
 */
import { Effect, Struct } from "effect"
import { GraphQLMiddleware } from "effect/graphql"
import { Headers } from "effect/http"
import { Token } from "#src/hardcover/token.ts"

/** Attaches the call's bearer token before the document is sent. */
class Auth extends GraphQLMiddleware.Service<Auth, { readonly requires: Token }>()("hardcover-oauth-mcp/hardcover/auth") {}

/** The middleware: the token in the call's context becomes the `Authorization` header. */
const authMiddleware: GraphQLMiddleware.Implementation<never, Token> = GraphQLMiddleware.mapRequest((request) =>
  Effect.map(Effect.service(Token), (token) =>
    Struct.evolve(request, { headers: (headers) => Headers.set(headers, "authorization", `Bearer ${token}`) }),
  ),
)

/**
 * Application module, not a public API.
 * @internal
 */
export { Auth, authMiddleware }
