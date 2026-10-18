/**
 * A scripted Hardcover endpoint for the GraphQL executor tests. While installed,
 * `fetch` answers from the current scenario's replies, in order, and records the
 * bearer token each request carried.
 */
import { Effect, Exit, Option, Schema, pipe } from "effect"
import type { ClientOptions } from "#src/hardcover/client.ts"
import type { HardcoverError } from "#src/hardcover/errors.ts"
import { makeExecutor } from "#src/hardcover/client.ts"
import { spyOn } from "bun:test"

/** What the connection hands the executor when asked for a token, as `makeExecutor` declares it. */
type TokenResult = Awaited<ReturnType<ClientOptions["accessToken"]>>

interface Reply {
  readonly body: unknown
  readonly headers?: Readonly<Record<string, string>>
  readonly status: number
}

interface Scenario {
  readonly mutation?: boolean
  readonly replies: ReadonlyArray<Reply>
  readonly tokens?: ReadonlyArray<TokenResult>
}

interface Outcome {
  readonly exit: Exit.Exit<unknown, HardcoverError>
  /** The `HardcoverError` kind the call failed with, if it failed with one. */
  readonly kind: string
  /** The advice the `HardcoverError` carries, or empty. */
  readonly message: string
  /** The token each refresh named as rejected; none for the first load. */
  readonly rejected: ReadonlyArray<Option.Option<string>>
  readonly seenTokens: ReadonlyArray<string>
}

const GRAPHQL_URL = "https://example.test/graphql"
const QUERY = "{ me { id } }"
const NO_AUTHORIZATION = "(no authorization header)"
const NO_FAILURE = "(no HardcoverError)"

/** What the endpoint answers once the scenario's replies run out. */
const EXHAUSTED: Reply = { body: {}, status: 500 }

const NO_TOKEN: TokenResult = { message: "The scenario ran out of tokens.", ok: false, reason: "unavailable" }

const DEFAULT_TOKENS: ReadonlyArray<TokenResult> = [
  { ok: true, token: "t1" },
  { ok: true, token: "t2" },
]

const Authorized = Schema.Struct({ headers: Schema.Struct({ authorization: Schema.String }) })

const network: { replies: Array<Reply>; seenTokens: Array<string> } = { replies: [], seenTokens: [] }

const authorization = (init: unknown): string =>
  pipe(
    Schema.decodeUnknownOption(Authorized)(init),
    Option.map((decoded) => decoded.headers.authorization),
    Option.getOrElse(() => NO_AUTHORIZATION),
  )

const nextReply = (): Reply =>
  pipe(
    network.replies.shift(),
    Option.fromNullishOr,
    Option.getOrElse(() => EXHAUSTED),
  )

const respond = (reply: Reply): Response => Response.json(reply.body, { headers: reply.headers ?? {}, status: reply.status })

const scriptedFetch: typeof fetch = Object.assign(
  (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    network.seenTokens.push(authorization(init))
    return Promise.resolve(respond(nextReply()))
  },
  { preconnect: globalThis.fetch.preconnect },
)

/** Replaces `fetch` with the scripted endpoint until the test's hooks call `mock.restore()`. */
const installScriptedFetch = (): void => {
  spyOn(globalThis, "fetch").mockImplementation(scriptedFetch)
}

const tokenSource = (
  tokens: ReadonlyArray<TokenResult>,
): { readonly accessToken: (rejected?: string) => Promise<TokenResult>; readonly rejected: ReadonlyArray<Option.Option<string>> } => {
  const queue = [...tokens]
  const rejected: Array<Option.Option<string>> = []
  return {
    accessToken: (rejectedToken?: string): Promise<TokenResult> => {
      rejected.push(Option.fromNullishOr(rejectedToken))
      return Promise.resolve(
        pipe(
          queue.shift(),
          Option.fromNullishOr,
          Option.getOrElse(() => NO_TOKEN),
        ),
      )
    },
    rejected,
  }
}

/**
 * Runs one query or mutation against the scripted endpoint.
 * @param {Scenario} scenario The replies to send, whether the document is a mutation, and the tokens the connection hands out.
 * @returns {Effect.Effect<Outcome>} How the call ended, the rejected tokens, and the tokens Hardcover saw.
 */
const run = (scenario: Scenario): Effect.Effect<Outcome> =>
  Effect.gen(function* runScenario() {
    network.replies = [...scenario.replies]
    network.seenTokens = []
    const source = tokenSource(scenario.tokens ?? DEFAULT_TOKENS)
    const execute = makeExecutor({ accessToken: source.accessToken, url: GRAPHQL_URL })
    const exit = yield* Effect.exit(execute({ query: QUERY }, { mutation: scenario.mutation ?? false }))
    const failure = Exit.findErrorOption(exit)
    return {
      exit,
      kind: Option.match(failure, { onNone: () => NO_FAILURE, onSome: (error) => error.kind }),
      message: Option.match(failure, { onNone: () => "", onSome: (error) => error.message }),
      rejected: source.rejected,
      seenTokens: [...network.seenTokens],
    }
  })

export { installScriptedFetch, run }
export type { TokenResult }
