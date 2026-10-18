/** Fetches Hardcover's published API docs for `scripts/sync-schema.ts`. */
import { Effect } from "effect"
import { HttpClient as Http } from "effect/http"
import type { HttpClientResponse } from "effect/http"
import { ScriptError } from "#root/scripts/script-io.ts"

const OK = 200
const DOCS_REPOSITORY = "hardcoverapp/hardcover-docs"

const fetchFailed = (path: string, status: number): ScriptError =>
  ScriptError.make({ cause: status, message: `GET ${path}: HTTP ${status}` })

const readBody = (path: string, response: HttpClientResponse.HttpClientResponse): Effect.Effect<string, ScriptError> =>
  response.status === OK
    ? response.text.pipe(Effect.mapError((cause) => ScriptError.make({ cause, message: `GET ${path}: unreadable body` })))
    : Effect.fail(fetchFailed(path, response.status))

const fetchText = (input: { readonly base: string; readonly path: string }): Effect.Effect<string, ScriptError, Http.HttpClient> =>
  Effect.gen(function* fetchDocument() {
    const response = yield* Http.get(`${input.base}/${input.path}`).pipe(
      Effect.mapError((cause) => ScriptError.make({ cause, message: `GET ${input.path} failed` })),
    )
    return yield* readBody(input.path, response)
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { DOCS_REPOSITORY, fetchText }
