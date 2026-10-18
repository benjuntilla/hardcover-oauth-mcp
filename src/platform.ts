/**
 * The Effect services this Worker runs with: Effect's fetch client and Web Crypto. One runtime per
 * isolate serves the Worker's handlers, the Durable Object, and the GraphQL executors.
 */
import { Crypto, Effect, Layer, ManagedRuntime, Tracer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

/**
 * Sends each request with the `fetch` that is current, as a plain `fetch()` call would; Effect's
 * fetch client on its own keeps the first one it sees.
 * @param {HttpClient.HttpClient} client Effect's fetch client.
 * @returns {HttpClient.HttpClient} The client.
 */
const withCurrentFetch = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transformResponse(client, (response) => Effect.provideService(response, FetchHttpClient.Fetch, globalThis.fetch))

/** Effect's fetch client, without trace headers. */
const Http: Layer.Layer<HttpClient.HttpClient> = Layer.effect(HttpClient.HttpClient)(
  Effect.service(HttpClient.HttpClient).pipe(Effect.map(withCurrentFetch)),
).pipe(Layer.provide(FetchHttpClient.layer), Layer.merge(Layer.succeed(Tracer.DisablePropagation, true)))

/** Effect's `Crypto` on the Web Crypto API that Workers provide. */
const WebCrypto: Layer.Layer<Crypto.Crypto> = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    digest: (algorithm, data) =>
      Effect.map(
        Effect.promise(() => crypto.subtle.digest(algorithm, new Uint8Array(data))),
        (digest) => new Uint8Array(digest),
      ),
    randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  }),
)

/** The runtime, built on first use. */
const platform: ManagedRuntime.ManagedRuntime<Crypto.Crypto | HttpClient.HttpClient, never> = ManagedRuntime.make(
  Layer.merge(Http, WebCrypto),
)

/**
 * Application module, not a public API.
 * @internal
 */
export { platform }
