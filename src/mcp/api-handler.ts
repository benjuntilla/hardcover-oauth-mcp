/**
 * Everything under `/mcp` after `OAuthProvider` has validated the MCP access
 * token. The Worker handles authorization only: the allowlist, the per-account
 * rate limit, and scope step-up. It then forwards the request to the
 * connection's Durable Object, which runs the MCP server.
 */
import { Array as Arr, Effect, Option, Predicate, Schema, pipe } from "effect"
import { TOOL_POLICIES, toolAllowed } from "#src/mcp/server.ts"
import { json, rpcError } from "#src/mcp/jsonrpc.ts"
import type { Env } from "#src/env.ts"
import type { ToolPolicy } from "#src/mcp/define.ts"
import { insufficientScope } from "@cloudflare/workers-oauth-provider"
import { isAllowedUser } from "#src/hardcover/graphql.ts"

const FORBIDDEN = 403
const TOO_MANY = 429
const TOO_MANY_CODE = -32_000
const RETRY_AFTER = "60"
const FIRST_ALTERNATIVE = 1

/** What `completeAuthorization()` stored with the grant (`GrantProps`). */
const Props = Schema.Struct({
  connectionId: Schema.String,
  hcUserId: Schema.Finite,
  librarianRoles: Schema.NullOr(Schema.Array(Schema.String)),
  supporter: Schema.Boolean,
  username: Schema.String,
})

/** The parts of `OAuthResourceAuth` this handler reads. */
const Auth = Schema.Struct({
  audience: Schema.String,
  scope: Schema.Array(Schema.String),
  token: Schema.String,
})

type ValidatedAuth = typeof Auth.Type

/** A `tools/call` message, the only kind whose scopes are checked here. */
const ToolCall = Schema.Struct({ method: Schema.Literal("tools/call"), params: Schema.Struct({ name: Schema.String }) })

/** A request body that is JSON. */
const JsonBody = Schema.fromJsonString(Schema.Unknown)

/**
 * The parsed messages of a POST body: a batch, one message, or none when it isn't JSON.
 * @param {string} body The POST body.
 * @returns {ReadonlyArray<unknown>} The messages.
 */
const messagesOf = (body: string): ReadonlyArray<unknown> =>
  pipe(
    Schema.decodeOption(JsonBody)(body),
    Option.filter(Predicate.isTruthy),
    Option.match({ onNone: (): ReadonlyArray<unknown> => [], onSome: (parsed) => (Arr.isArray(parsed) ? parsed : [parsed]) }),
  )

/**
 * Tool calls the token's scopes don't cover, as a step-up challenge listing what it has plus what's missing:
 * the tool's required scopes, plus the first alternative when it takes any of several.
 * @param {string} body The POST body.
 * @param {ValidatedAuth} auth The validated token.
 * @returns {Option.Option<Response>} The challenge, or none when the body calls no tool it can't use.
 */
const stepUp = (body: string, auth: ValidatedAuth): Option.Option<Response> => {
  const granted = new Set(auth.scope)
  const policyOf = (message: unknown): Option.Option<ToolPolicy> =>
    pipe(
      Schema.decodeUnknownOption(ToolCall)(message),
      Option.flatMap((call) => Option.fromNullishOr(TOOL_POLICIES.get(call.params.name))),
      Option.filter((policy) => !toolAllowed({ granted, policy })),
    )
  return pipe(
    messagesOf(body),
    Arr.findFirst(policyOf),
    Option.map((policy) => {
      const alternative = Option.match(policy.anyOf, { onNone: () => [], onSome: Arr.take(FIRST_ALTERNATIVE) })
      const needed = pipe(
        Arr.appendAll(policy.scopes, alternative),
        Arr.filter((scope) => !granted.has(scope)),
      )
      // `insufficientScope` reads only the audience from the token.
      return insufficientScope(
        { audience: auth.audience, scope: Arr.copy(auth.scope), token: auth.token },
        Arr.dedupe(Arr.appendAll(auth.scope, needed)),
      )
    }),
  )
}

/**
 * The token `OAuthProvider` validated. A context without it is a defect.
 * @param {ExecutionContext} ctx The request context.
 * @returns {Effect.Effect<ValidatedAuth>} The token.
 */
const authOf = (ctx: ExecutionContext): Effect.Effect<ValidatedAuth> =>
  Predicate.hasProperty(ctx, "auth")
    ? Effect.orDie(Schema.decodeUnknownEffect(Auth)(ctx.auth))
    : Effect.die(new Error("OAuthProvider passed no token to the /mcp handler"))

/**
 * The per-account rate limit's refusal, when the account is over it.
 * @param {Env} env The Worker bindings.
 * @param {number} hcUserId The Hardcover account.
 * @returns {Effect.Effect<Option.Option<Response>>} The refusal.
 */
const rateLimited = (env: Env, hcUserId: number): Effect.Effect<Option.Option<Response>> =>
  Effect.map(
    Effect.promise(() => env.MCP_RATE_LIMIT.limit({ key: String(hcUserId) })),
    ({ success }) =>
      success
        ? Option.none()
        : Option.some(
            json({
              body: rpcError({
                code: TOO_MANY_CODE,
                message: "Too many requests to this server from this Hardcover account. Wait a minute and try again.",
              }),
              headers: { "retry-after": RETRY_AFTER },
              status: TOO_MANY,
            }),
          ),
  )

/**
 * The Durable Object's response, disposing the RPC result once its body has been read. Until then the call stays
 * open, and Cloudflare would record it as canceled when this request ends.
 * @param {Response & Disposable} response The RPC result.
 * @returns {Response} The response to send.
 */
const releasedAfterBody = (response: Response & Disposable): Response => {
  const release = (): void => {
    response[Symbol.dispose]()
  }
  return Option.match(Option.fromNullishOr(response.body), {
    onNone: () => {
      release()
      return response
    },
    onSome: (body) => new Response(body.pipeThrough(new TransformStream({ flush: release })), response),
  })
}

/**
 * Forwards the request to the connection's Durable Object, with the grant and without the bearer token.
 * @param {object} options The request and what the token grants.
 * @param {Request} options.request The incoming request.
 * @param {Option.Option<string>} options.body The body, for a POST.
 * @param {Env} options.env The Worker bindings.
 * @param {typeof Props.Type} options.props The grant.
 * @param {ValidatedAuth} options.auth The validated token.
 * @returns {Effect.Effect<Response>} The connection's response.
 */
const forward = (options: {
  readonly request: Request
  readonly body: Option.Option<string>
  readonly env: Env
  readonly props: typeof Props.Type
  readonly auth: ValidatedAuth
}): Effect.Effect<Response> =>
  Effect.gen(function* forwardRequest() {
    const { auth, props, request } = options
    const grant = { librarianRoles: props.librarianRoles, scopes: auth.scope, supporter: props.supporter }
    const headers = new Headers(request.headers)
    headers.delete("authorization")
    // Bearer tokens aren't ambient credentials and OAuthProvider already answers CORS, so Effect's
    // Origin allowlist (meant for unauthenticated local servers) doesn't apply here.
    headers.delete("origin")
    const connection = options.env.HARDCOVER_CONNECTION.getByName(props.connectionId)
    const init = { body: Option.getOrNull(options.body), headers, method: request.method }
    const response = yield* Effect.promise(() => connection.serve(new Request(request.url, init), grant))
    return releasedAfterBody(response)
  })

/**
 * The authorization checks and the forward. A context without the grant is a defect.
 * @param {Request} request The incoming request.
 * @param {Env} env The Worker bindings.
 * @param {ExecutionContext} ctx The request context, with the grant as `props` and the token as `auth`.
 * @returns {Effect.Effect<Response>} The response.
 */
const authorizeAndForward = (request: Request, env: Env, ctx: ExecutionContext): Effect.Effect<Response> =>
  Effect.gen(function* checkAndForward() {
    const props = yield* Effect.orDie(Schema.decodeUnknownEffect(Props)(ctx.props))
    const auth = yield* authOf(ctx)
    if (!isAllowedUser(env.ALLOWED_HARDCOVER_USERS, { id: props.hcUserId, username: props.username })) {
      const description = `Hardcover user @${props.username} is not allowed on this server.`
      return json({ body: { error: "access_denied", error_description: description }, status: FORBIDDEN })
    }
    const refusal = yield* rateLimited(env, props.hcUserId)
    if (Option.isSome(refusal)) {
      return refusal.value
    }
    const body = request.method === "POST" ? Option.some(yield* Effect.promise(() => request.text())) : Option.none()
    return yield* pipe(
      body,
      Option.flatMap((text) => stepUp(text, auth)),
      Option.match({ onNone: () => forward({ auth, body, env, props, request }), onSome: Effect.succeed }),
    )
  })

/**
 * The `/mcp` handler `OAuthProvider` calls once it has validated the token.
 */
const mcpApiHandler = {
  /**
   * Authorizes the request and forwards it to the connection's Durable Object.
   * @param {Request} request The incoming request.
   * @param {Env} env The Worker bindings.
   * @param {ExecutionContext} ctx The request context, carrying the validated grant.
   * @returns {Promise<Response>} The response.
   */
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return Effect.runPromise(authorizeAndForward(request, env, ctx))
  },
}

/**
 * Application module, not a public API.
 * @internal
 */
export { mcpApiHandler }
