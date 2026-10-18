/**
 * Durable Object storage for one Hardcover connection, with this isolate's copy
 * of the stored state. A failed storage call is a defect, as it always was.
 */
import { Clock, Effect, Option, Predicate, Schema, Struct } from "effect"
import { IDLE_TTL_MS, StoredState } from "#src/connection/state.ts"
import type { ConnectionState } from "#src/connection/state.ts"

/** Persist `lastUsedAt` at most this often, so tool calls don't each cost a storage write. */
const TOUCH_HOURS = 12
const SECONDS_PER_HOUR = 3600
const MILLIS_PER_SECOND = 1000
const TOUCH_INTERVAL_MS = TOUCH_HOURS * SECONDS_PER_HOUR * MILLIS_PER_SECOND
const STATE_KEY = "state"

/**
 * A stored connection. Earlier deployments kept a connection Hardcover refused, marked with `revoked`;
 * the field is read so such a connection is erased, not used.
 */
const StoredRecord = StoredState.mapFields(Struct.assign({ revoked: Schema.optionalKey(Schema.Unknown) }))

/** What the storage holds under the state key: a connection, or nothing. */
const Stored = Schema.OptionFromUndefinedOr(StoredRecord)

/** The Durable Object storage calls a connection makes. */
interface Storage {
  readonly get: (key: string) => Promise<unknown>
  readonly put: (key: string, value: ConnectionState) => Promise<void>
  readonly setAlarm: (scheduledTime: number) => Promise<void>
  readonly deleteAlarm: () => Promise<void>
  readonly deleteAll: () => Promise<void>
}

/** One connection's storage. */
class ConnectionStore {
  readonly #storage: Storage
  #known = false
  #state: Option.Option<ConnectionState> = Option.none()

  /**
   * A store over the object's storage.
   * @param {Storage} storage The Durable Object's storage.
   */
  public constructor(storage: Storage) {
    this.#storage = storage
  }

  /**
   * The stored connection, read once per isolate. One an earlier deployment marked revoked is erased
   * instead. A stored value that isn't a connection is a defect.
   * @returns {Effect.Effect<Option.Option<ConnectionState>>} The connection, or none.
   */
  public load(): Effect.Effect<Option.Option<ConnectionState>> {
    return Effect.suspend(() =>
      this.#known
        ? Effect.succeed(this.#state)
        : Effect.promise(() => this.#storage.get(STATE_KEY)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Stored)),
            Effect.orDie,
            Effect.flatMap((stored) =>
              Option.exists(stored, (state) => Predicate.isNotUndefined(state.revoked))
                ? Effect.as(this.forget(), Option.none())
                : Effect.sync(() => {
                    this.#remember(stored)
                    return stored
                  }),
            ),
          ),
    )
  }

  /**
   * Persists the connection and remembers it.
   * @param {ConnectionState} state The state to store.
   * @returns {Effect.Effect<void>} Done once stored.
   */
  public save(state: ConnectionState): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#remember(Option.some(state))
    }).pipe(Effect.andThen(Effect.promise(() => this.#storage.put(STATE_KEY, state))))
  }

  /**
   * Records that the connection was used, at most once per touch interval, and pushes its idle alarm back.
   * It updates the state as stored now, so a refresh that finished since the caller's read isn't undone.
   * @returns {Effect.Effect<void>} Done once recorded.
   */
  public touch(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* touchState() {
      const loaded = yield* this.load()
      const now = yield* Clock.currentTimeMillis
      if (Option.isNone(loaded) || now - loaded.value.lastUsedAt < TOUCH_INTERVAL_MS) {
        return
      }
      yield* this.save(Struct.evolve(loaded.value, { lastUsedAt: () => now }))
      yield* this.setAlarm(now + IDLE_TTL_MS)
    })
  }

  /**
   * Schedules the idle check.
   * @param {number} at Epoch milliseconds.
   * @returns {Effect.Effect<void>} Done once scheduled.
   */
  public setAlarm(at: number): Effect.Effect<void> {
    return Effect.promise(() => this.#storage.setAlarm(at))
  }

  /**
   * Forgets the connection and erases its storage.
   * @returns {Effect.Effect<void>} Done once erased.
   */
  public forget(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.#remember(Option.none())
    }).pipe(
      Effect.andThen(Effect.promise(() => this.#storage.deleteAlarm())),
      Effect.andThen(Effect.promise(() => this.#storage.deleteAll())),
    )
  }

  /**
   * Keeps the isolate's copy of the stored state.
   * @param {Option.Option<ConnectionState>} state The state, or none once erased.
   */
  #remember(state: Option.Option<ConnectionState>): void {
    this.#state = state
    this.#known = true
  }
}

/**
 * Application module, not a public API.
 * @internal
 */
export { ConnectionStore }
/**
 * Application module, not a public API.
 * @internal
 */
export type { Storage }
