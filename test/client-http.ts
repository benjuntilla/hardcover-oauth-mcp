/**
 * Effect HTTP client for the scripted OAuth and MCP walk. Redirects stay
 * manual so the consent walk can read each `Location` itself, and trace
 * headers stay off so each request carries only the headers the walk sets.
 */
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http"
import type { HttpClientError, HttpClientResponse } from "effect/http"

const JSON_TYPE = "application/json"
const FORM_TYPE = "application/x-www-form-urlencoded"
const MANUAL = "manual"
const SUCCESS_MIN = 200
const SUCCESS_MAX = 299

const manual = Layer.succeed(FetchHttpClient.RequestInit, { redirect: MANUAL })

const untraced = Layer.succeed(HttpClient.TracerPropagationEnabled, false)

const clientLayer = Layer.mergeAll(FetchHttpClient.layer, manual, untraced)

type Method = "DELETE" | "GET" | "POST"

type Sent = Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient>

interface Bodiless {
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly method: Method
  readonly url: string | URL
}

interface Outgoing extends Bodiless {
  readonly body: HttpBody.HttpBody
}

const requestOf = (request: Bodiless): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.make(request.method)(request.url, { headers: request.headers ?? {} })

/**
 * Sends a request without a body. Its headers go out as given, including any `content-type`.
 * @param {Bodiless} request The method, URL, and headers.
 * @returns {Sent} The response.
 */
const sendBodiless = (request: Bodiless): Sent => HttpClient.execute(requestOf(request))

/**
 * Sends a request with a body, whose content type sets the `content-type` header.
 * @param {Outgoing} request The method, URL, headers, and body.
 * @returns {Sent} The response.
 */
const send = (request: Outgoing): Sent => HttpClient.execute(HttpClientRequest.setBody(requestOf(request), request.body))

const get = (options: { readonly headers?: Readonly<Record<string, string>> | undefined; readonly url: string | URL }): Sent =>
  sendBodiless({ headers: options.headers, method: "GET", url: options.url })

const post = (options: {
  readonly body: HttpBody.HttpBody
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly url: string
}): Sent => send({ body: options.body, headers: options.headers, method: "POST", url: options.url })

const jsonBody = (value: unknown): Effect.Effect<HttpBody.HttpBody, HttpBody.HttpBodyError> => HttpBody.json(value, JSON_TYPE)

const formBody = (fields: URLSearchParams): HttpBody.HttpBody => HttpBody.urlParams(fields, FORM_TYPE)

const textBody = (options: { readonly text: string; readonly type: string }): HttpBody.HttpBody => HttpBody.text(options.text, options.type)

const textOf = (response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, HttpClientError.HttpClientError> => response.text

const succeeded = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= SUCCESS_MIN && response.status <= SUCCESS_MAX

/**
 * Decodes a JSON response body with a schema.
 * @param {object} options The response and the schema for its body.
 * @param {HttpClientResponse.HttpClientResponse} options.response The response to read.
 * @param {Schema.Decoder} options.schema The schema the body must match.
 * @returns {Effect.Effect} The decoded body.
 */
const decodeJson = <Shape extends Schema.Decoder<unknown>>(options: {
  readonly response: HttpClientResponse.HttpClientResponse
  readonly schema: Shape
}): Effect.Effect<Shape["Type"], HttpClientError.HttpClientError | Schema.SchemaError> =>
  options.response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(options.schema)))

/**
 * Application module, not a public API.
 * @internal
 */
export { clientLayer, decodeJson, formBody, get, jsonBody, post, send, sendBodiless, succeeded, textBody, textOf }
