/**
 * The session that "authorizes through consent and Hardcover" leaves for the
 * end-to-end cases after it.
 */
import { Context, Effect, Layer, Option, Ref } from "effect"
import type { Authorized } from "#test/client-authorize.ts"
import { ClientError } from "#test/client-walk.ts"

/** The authorized session, once the authorization case has run. */
class Session extends Context.Service<Session, Ref.Ref<Option.Option<Authorized>>>()("hardcover-oauth-mcp/test/e2e-session/Session") {}

const sessionLayer = Layer.effect(Session, Ref.make(Option.none<Authorized>()))

const currentSession: Effect.Effect<Authorized, ClientError, Session> = Effect.gen(function* readSession() {
  const stored = yield* Ref.get(yield* Session)
  if (Option.isNone(stored)) {
    return yield* ClientError.make({ message: "no session: the authorization test did not finish" })
  }
  return stored.value
})

const remember = (session: Authorized): Effect.Effect<void, never, Session> =>
  Effect.gen(function* rememberSession() {
    yield* Ref.set(yield* Session, Option.some(session))
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { currentSession, remember, sessionLayer }
