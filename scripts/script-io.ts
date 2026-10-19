/** Bun file helpers for the repo scripts, with typed failures. */
import { Effect, Schema } from "effect"

class ScriptError extends Schema.TaggedError<ScriptError, { readonly brand: unique symbol }>()("ScriptError", {
  cause: Schema.Unknown,
  message: Schema.String,
}) {}

const readText = (url: URL): Effect.Effect<string, ScriptError> =>
  Effect.tryPromise({
    catch: (cause) => ScriptError.make({ cause, message: `Could not read ${url.pathname}` }),
    try: () => Bun.file(url).text(),
  })

const writeText = (input: { readonly text: string; readonly url: URL }): Effect.Effect<number, ScriptError> =>
  Effect.tryPromise({
    catch: (cause) => ScriptError.make({ cause, message: `Could not write ${input.url.pathname}` }),
    try: () => Bun.write(input.url, input.text),
  })

export { ScriptError, readText, writeText }
