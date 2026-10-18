/**
 * Hardcover's GraphQL endpoint through Effect's `effect/graphql` client.
 *
 * `GraphQLClient` builds each request and decodes each result; the protocol
 * here sends it with `HttpClient`. A 200 whose body is a GraphQL response
 * (data or errors) is the protocol's answer, with its status and headers. Any
 * other answer fails as a `TransportError` that keeps the status and headers,
 * with the `HttpClientError` holding the response as its cause, so Hardcover's
 * own error body stays readable. `runDocument` reports what Hardcover replied:
 * GraphQL `data`, an HTTP answer that wasn't data, or no answer at all.
 */
import { Array as Arr, Cause, Context, Data, Duration, Effect, Option, Predicate, Record as Rec, Schema, Stream, Struct } from "effect"
import { Auth, authMiddleware } from "#src/hardcover/auth.ts"
import { GraphQL, GraphQLClient, GraphQLClientError, GraphQLGroup, GraphQLProtocol } from "effect/graphql"
import { Headers, HttpClient, HttpClientError, HttpClientRequest } from "effect/http"
import type { GraphQLRequest } from "#src/hardcover/graphql.ts"
import type { HttpClientResponse } from "effect/http"
import { Token } from "#src/hardcover/token.ts"
import { USER_AGENT } from "#src/env.ts"

/** Hardcover cancels queries after 30 seconds (search after 2); give up just before. */
const GRAPHQL_TIMEOUT_SECONDS = 29
const HTTP_OK = 200
const OPERATION_NAME = /\b(?:query|mutation)\s+(?<name>[_A-Za-z][_0-9A-Za-z]*)/v

/** The variables of any document. */
const Variables = Schema.Record(Schema.String, Schema.Unknown)

/** A GraphQL response body as the client decodes it; `status` and `headers` are transport metadata. */
const ExecutionBody = GraphQLProtocol.ExecutionResult.mapFields(Struct.omit(["headers", "status"]))

/** What Hardcover answered over HTTP, when it was not GraphQL `data`. */
interface HardcoverAnswer {
  readonly status: number
  readonly headers: Headers.Headers
  /** The JSON body, or none when it wasn't JSON. */
  readonly body: Option.Option<unknown>
}

/** What one document got back from Hardcover. */
type Reply = Data.TaggedEnum<{
  /** An HTTP answer other than GraphQL `data`: an error status, GraphQL errors, or a body that isn't GraphQL. */
  Answered: { readonly answer: HardcoverAnswer }
  /** The operation's `data`, an object. */
  Data: { readonly data: unknown }
  /** No answer: Hardcover could not be reached, or did not answer in time. */
  Unreachable: { readonly timedOut: boolean }
}>

const Replies = Data.taggedEnum<Reply>()

interface ProtocolOptions {
  readonly http: HttpClient.HttpClient
  /** Whether the caller named the operation. Only then is `operationName` sent: Hasura refuses it for an anonymous operation. */
  readonly named: boolean
  readonly url: string
}

/**
 * The operation's name, for the client and for defect reports (never its variables or full text).
 * @param {GraphQLRequest} request The document.
 * @returns {string} The name the caller gave, the document's own, or `anonymous`.
 */
const operationName = (request: GraphQLRequest): string =>
  request.operationName ?? OPERATION_NAME.exec(request.query)?.groups?.name ?? "anonymous"

/**
 * Whether a body is a GraphQL response the client can turn into data or errors.
 * @param {unknown} body The parsed body.
 * @returns {boolean} True when it carries an object as `data`, or GraphQL errors.
 */
const isGraphQLResponse = (body: unknown): boolean =>
  Option.match(Schema.decodeUnknownOption(ExecutionBody)(body), {
    onNone: () => false,
    onSome: (result) => Predicate.isObjectOrArray(result.data) || Arr.isReadonlyArrayNonEmpty(result.errors ?? []),
  })

/**
 * Why a response is not the protocol's answer, keeping the response so its status, headers, and body survive.
 * @param {HttpClientResponse.HttpClientResponse} response The response.
 * @returns {HttpClientError.HttpClientError} A status error, or a decode error for a 200 that isn't GraphQL.
 */
const notGraphQL = (response: HttpClientResponse.HttpClientResponse): HttpClientError.HttpClientError => {
  const details = { request: response.request, response }
  return new HttpClientError.HttpClientError({
    reason:
      response.status === HTTP_OK
        ? new HttpClientError.DecodeError(Struct.assign(details, { description: "not a GraphQL response" }))
        : new HttpClientError.StatusCodeError(Struct.assign(details, { description: `HTTP ${response.status}` })),
  })
}

/**
 * The protocol's answer for one response: a 200 with a GraphQL response body.
 * @param {HttpClientResponse.HttpClientResponse} response The response.
 * @returns {Effect.Effect} The body with its status and headers, or the response as a failure.
 */
const protocolAnswer = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<{ readonly body: unknown; readonly headers: Headers.Headers; readonly status: number }, HttpClientError.HttpClientError> =>
  Effect.flatMap(Effect.option(response.json), (body) =>
    response.status === HTTP_OK && Option.exists(body, isGraphQLResponse)
      ? Effect.succeed({ body: Option.getOrUndefined(body), headers: response.headers, status: response.status })
      : Effect.fail(notGraphQL(response)),
  )

/**
 * The protocol: one POST per document, with the headers Hardcover has always been sent.
 * @param {ProtocolOptions} options The HTTP client, the endpoint, and whether to send `operationName`.
 * @returns {GraphQLProtocol.GraphQLProtocol["Service"]} The protocol.
 */
const hardcoverProtocol = (options: ProtocolOptions): GraphQLProtocol.GraphQLProtocol["Service"] => ({
  execute: (request) => {
    const body = Struct.pick(request, options.named ? ["operationName", "query", "variables"] : ["query", "variables"])
    const post = HttpClientRequest.post(options.url).pipe(
      HttpClientRequest.setHeaders(request.headers),
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": USER_AGENT }),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    return options.http.execute(post).pipe(
      Effect.flatMap(protocolAnswer),
      Effect.timeout(Duration.seconds(GRAPHQL_TIMEOUT_SECONDS)),
      // A timeout keeps `TimeoutError` as the cause, so the executor can say so.
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? GraphQLClientError.TransportError.make({ cause: error, description: "Hardcover did not answer in time" })
          : GraphQLClientError.TransportError.fromHttpClientError(error),
      ),
    )
  },
  subscribe: () =>
    Stream.fail(GraphQLClientError.TransportError.make({ description: "Hardcover's GraphQL endpoint has no subscriptions", fatal: true })),
})

/**
 * The response a transport error carries, when Hardcover answered at all.
 * @param {unknown} cause The transport error's cause.
 * @returns {Option.Option<HttpClientResponse.HttpClientResponse>} The response.
 */
const responseOf = (cause: unknown): Option.Option<HttpClientResponse.HttpClientResponse> =>
  HttpClientError.isHttpClientError(cause) ? Option.fromNullishOr(cause.response) : Option.none()

/**
 * What a failed call means: the HTTP answer behind it, or no answer.
 * @param {GraphQLClientError.GraphQLClientError} error The client's failure.
 * @returns {Effect.Effect<Reply>} The reply. Encoding, decoding, and paging failures can't happen with these schemas and are defects.
 */
const replyOf = (error: GraphQLClientError.GraphQLClientError): Effect.Effect<Reply> => {
  const { reason } = error
  if (Schema.is(GraphQLClientError.ResponseError)(reason)) {
    const body = Option.some({ data: reason.data, errors: reason.errors })
    return Effect.succeed(
      Replies.Answered({ answer: { body, headers: reason.headers ?? Headers.empty, status: reason.status ?? HTTP_OK } }),
    )
  }
  if (!Schema.is(GraphQLClientError.TransportError)(reason)) {
    return Effect.die(error)
  }
  return Option.match(responseOf(reason.cause), {
    onNone: () => Effect.succeed(Replies.Unreachable({ timedOut: Cause.isTimeoutError(reason.cause) })),
    onSome: (response) =>
      Effect.map(Effect.option(response.json), (body) =>
        Replies.Answered({ answer: { body, headers: response.headers, status: response.status } }),
      ),
  })
}

/**
 * Runs one document through `GraphQLClient` over the Hardcover protocol, with the bearer token attached by the auth middleware.
 * @param {object} options The document, the endpoint, and the token.
 * @param {string} options.accessToken The bearer token for this attempt.
 * @param {GraphQLRequest} options.request The document, its variables, and its operation name.
 * @param {boolean} options.mutation Whether the operation changes data.
 * @param {string} options.url Hardcover's GraphQL URL.
 * @returns {Effect.Effect<Reply, never, HttpClient.HttpClient>} What Hardcover replied.
 */
const runDocument = (options: {
  readonly accessToken: string
  readonly mutation: boolean
  readonly request: GraphQLRequest
  readonly url: string
}): Effect.Effect<Reply, never, HttpClient.HttpClient> =>
  Effect.gen(function* sendDocument() {
    const http = yield* HttpClient.HttpClient
    const name = operationName(options.request)
    const fields = { document: options.request.query, result: Schema.Unknown, variables: Variables }
    const operation = options.mutation ? GraphQL.mutation(name, fields) : GraphQL.query(name, fields)
    const protocol = hardcoverProtocol({ http, named: Predicate.isNotUndefined(options.request.operationName), url: options.url })
    const client = yield* GraphQLClient.make(GraphQLGroup.make(operation).middleware(Auth)).pipe(
      Effect.provideService(GraphQLProtocol.GraphQLProtocol, protocol),
      Effect.provideService(Auth, authMiddleware),
    )
    const call = yield* Effect.fromOption(Rec.get(client, name)).pipe(Effect.orDie)
    return yield* call(options.request.variables, { context: Context.make(Token, options.accessToken) }).pipe(
      Effect.map((data) => Replies.Data({ data })),
      Effect.catch(replyOf),
    )
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { Replies, operationName, runDocument }
/**
 * Application module, not a public API.
 * @internal
 */
export type { HardcoverAnswer, Reply }
