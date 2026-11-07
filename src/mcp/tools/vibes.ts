/** Vibes, through the SDK's vibes resource. Creating and tuning signals needs Supporter. */
import { Effect, Predicate, Schema } from "effect"
import { Json, JsonList, Privacy, call, privacySetting } from "./common.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { VibeCreate, VibeSignal } from "@hardcover/sdk"
import { Session } from "#src/mcp/session.ts"
import { Tool } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"

const MIN_SIGNAL_WEIGHT = -5
const MAX_SIGNAL_WEIGHT = 5
const VIBE_LIST_LIMIT = 100

const Signal = Schema.Struct({
  type: Schema.Literals(["book", "author", "genre", "axiom", "audience", "format", "series", "semantic", "popularity", "user"]),
  value: Schema.optionalKey(Schema.String).annotate({
    description: "For book, author, and user, the numeric id. For the others, the name or text. Popularity has no value.",
  }),
  weight: Schema.Int.check(Schema.isBetween({ maximum: MAX_SIGNAL_WEIGHT, minimum: MIN_SIGNAL_WEIGHT })),
})

const ListVibes = hardcoverTool({
  description: "The user's vibes (recommendation feeds) with their current ranked book ids.",
  kind: "read",
  name: "hardcover_list_vibes",
  parameters: Tool.EmptyParams,
  scopes: ["read:vibes"],
  success: Schema.Struct({ vibes: JsonList }),
  title: "List your vibes",
})

const VibeParams = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  privacy: Schema.optionalKey(Privacy),
  signals: Schema.optionalKey(Schema.Array(Signal)),
  title: Schema.NonEmptyString,
})

const CreateVibe = hardcoverTool({
  description:
    "Creates a custom vibe: a recommendation feed tuned by weighted signals (-5 to 5) such as books, authors, genres, or free text.",
  kind: "create",
  name: "hardcover_create_vibe",
  parameters: VibeParams,
  requires: ["supporter"],
  scopes: ["write:vibes"],
  success: Schema.Struct({ vibe: Json }),
  title: "Create a vibe",
})

const INTEGER_ID = /^\d+$/v

const signalId = (signal: typeof Signal.Type): Effect.Effect<number, HardcoverError> => {
  if (Predicate.isUndefined(signal.value) || !INTEGER_ID.test(signal.value)) {
    return HardcoverError.make({ kind: "invalid", message: `A ${signal.type} signal needs a numeric id in value.` })
  }
  return Effect.succeed(Number(signal.value))
}

type IdSignal = typeof Signal.Type & { readonly type: "book" | "author" | "user" }

const idSignal = (signal: IdSignal, id: number): VibeSignal => ({ id, type: signal.type, weight: signal.weight })

const isIdSignal = (signal: typeof Signal.Type): signal is IdSignal =>
  signal.type === "book" || signal.type === "author" || signal.type === "user"

const namedSignal = (signal: Exclude<typeof Signal.Type, IdSignal>, value: string): VibeSignal => {
  if (signal.type === "genre") {
    return { type: "genre", value, weight: signal.weight }
  }
  if (signal.type === "axiom") {
    return { type: "axiom", value, weight: signal.weight }
  }
  if (signal.type === "audience") {
    return { type: "audience", value, weight: signal.weight }
  }
  if (signal.type === "format") {
    return { type: "format", value, weight: signal.weight }
  }
  return { type: "series", value, weight: signal.weight }
}

const textSignal = (signal: Exclude<typeof Signal.Type, IdSignal>): VibeSignal => {
  const value = signal.value ?? ""
  if (signal.type === "semantic") {
    return { text: value, type: "semantic", weight: signal.weight }
  }
  if (signal.type === "popularity") {
    return { type: "popularity", weight: signal.weight }
  }
  return namedSignal(signal, value)
}

const vibeSignal = (signal: typeof Signal.Type): Effect.Effect<VibeSignal, HardcoverError> => {
  if (isIdSignal(signal)) {
    return Effect.map(signalId(signal), (id) => idSignal(signal, id))
  }
  return Effect.succeed(textSignal(signal))
}

const convertedSignals = (signals: ReadonlyArray<typeof Signal.Type>): Effect.Effect<Array<VibeSignal>, HardcoverError> =>
  Effect.gen(function* convert() {
    const converted: Array<VibeSignal> = []
    for (const signal of signals) {
      converted.push(yield* vibeSignal(signal))
    }
    return converted
  })

const vibeInput = (params: typeof CreateVibe.parametersSchema.Type): Effect.Effect<VibeCreate, HardcoverError> => {
  const input: VibeCreate = { title: params.title }
  if (Predicate.isNotUndefined(params.description)) {
    input.description = params.description
  }
  const privacy = privacySetting(params.privacy)
  if (Predicate.isNotUndefined(privacy)) {
    input.privacy = privacy
  }
  if (Predicate.isUndefined(params.signals)) {
    return Effect.succeed(input)
  }
  return Effect.map(convertedSignals(params.signals), (signals) => {
    input.signals = [...signals]
    return input
  })
}

const vibeHandlers = {
  hardcover_create_vibe: Effect.fn(function* createVibe(params: typeof CreateVibe.parametersSchema.Type) {
    const input = yield* vibeInput(params)
    const vibe = yield* call((hardcover) => hardcover.client.vibes.create(input))
    return { vibe }
  }),

  hardcover_list_vibes: Effect.fn(function* listVibes() {
    const { hcUserId } = yield* Session
    const page = yield* call((hardcover) => hardcover.client.vibes.forUser(hcUserId, { limit: VIBE_LIST_LIMIT }))
    return { vibes: page.items }
  }),
}

/**
 * Application module, not a public API.
 * @internal
 */
export { CreateVibe, ListVibes, vibeHandlers }
