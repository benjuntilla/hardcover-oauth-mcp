/**
 * The end-to-end harness: the mock Hardcover and `alchemy dev` pointed at it,
 * both as layers, so disposing the test file's runtime stops `alchemy dev`
 * and then the mock.
 */
import { Config, Context, Effect, Layer, Option, Schedule } from "effect"
import type { HttpBody, HttpClient, HttpClientError } from "effect/http"
import { clientLayer, get, succeeded } from "#test/client-http.ts"
import { ClientError } from "#test/client-walk.ts"
import type { GraphHandler } from "#test/mock-graphql.ts"
import { MOCK_PORT } from "#test/e2e-config.ts"
import type { MockHardcover } from "#test/mock-hardcover.ts"
import type { Schema } from "effect"
import { sessionLayer } from "#test/e2e-session.ts"
import { spawn } from "bun"
import { startMockHardcover } from "#test/mock-hardcover.ts"

/** Every way an end-to-end case can fail besides an assertion. */
type CaseError = ClientError | HttpBody.HttpBodyError | HttpClientError.HttpClientError | Schema.SchemaError

const BASE = "http://localhost:1337"
const BOOK_ID = 100
const DUNE = "Dune"
const ENABLED = "1"
const POLL = "500 millis"
const STARTUP = "90 seconds"

const booksByPk: GraphHandler = {
  run: (variables) => ({ id: variables.id, slug: "dune", title: DUNE }),
}

const userBooks: GraphHandler = {
  run: () => [{ book: { id: BOOK_ID, title: DUNE }, book_id: BOOK_ID, id: 7, rating: 4, status_id: 2 }],
}

/** The running mock Hardcover, for tests that inspect or change its state. */
class Mock extends Context.Service<Mock, MockHardcover>()("hardcover-oauth-mcp/test/e2e-setup/Mock") {}

const mockLayer = Layer.effect(
  Mock,
  Effect.acquireRelease(
    Effect.sync(() => startMockHardcover({ graphql: { books_by_pk: booksByPk, user_books: userBooks }, port: MOCK_PORT })),
    (mock) =>
      Effect.sync(() => {
        mock.stop()
      }),
  ),
)

/** `alchemy dev` with the e2e stack, which points the Worker at the mock (test/e2e.run.ts). */
const DEV_COMMAND = ["bun", "node_modules/alchemy/bin/alchemy.js", "dev", "test/e2e.run.ts", "--stage", "e2e", "--no-input"]

const devLayer = Layer.effectDiscard(
  Effect.gen(function* startAlchemyDev() {
    yield* Mock
    yield* Effect.acquireRelease(
      Effect.sync(() => spawn(DEV_COMMAND, { stderr: "inherit", stdout: "ignore" })),
      // Waits for the exit, which frees port 1337; otherwise the next run's readiness check can reach this server.
      (dev) =>
        Effect.promise(() => {
          dev.kill()
          return dev.exited
        }),
    )
  }),
)

const harnessLayer = Layer.mergeAll(clientLayer, devLayer.pipe(Layer.provideMerge(mockLayer)), sessionLayer)

const ready: Effect.Effect<boolean, never, HttpClient.HttpClient> = get({ url: `${BASE}/.well-known/oauth-authorization-server` }).pipe(
  Effect.map(succeeded),
  Effect.orElseSucceed(() => false),
)

const waitForWorker: Effect.Effect<void, ClientError, HttpClient.HttpClient> = ready.pipe(
  Effect.repeat({ schedule: Schedule.spaced(POLL), until: (up) => up }),
  Effect.asVoid,
  Effect.timeoutOrElse({ duration: STARTUP, orElse: () => Effect.fail(ClientError.make({ message: "alchemy dev did not start" })) }),
)

const skipped = Config.String("E2E").pipe(
  Config.option,
  Effect.map((value) => Option.isNone(value) || value.value !== ENABLED),
  Effect.orElseSucceed(() => true),
  Effect.runSync,
)

/**
 * Application module, not a public API.
 * @internal
 */
export { BASE, Mock, harnessLayer, skipped, waitForWorker }

/**
 * Application module, not a public API.
 * @internal
 */
export type { CaseError }
