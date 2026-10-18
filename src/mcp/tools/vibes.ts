/** Vibes: Hardcover's tunable recommendation feeds. Creating and tuning signals needs Supporter. */
import { Array as Arr, Effect, Option, Schema } from "effect"
import { Json, JsonList, Payload, Privacy, payload, privacyId, run } from "./common.ts"
import { GraphQL } from "effect/graphql"
import type { PrivacyName } from "./common.ts"
import { Session } from "#src/mcp/session.ts"
import { Tool } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"

const MIN_SIGNAL_WEIGHT = -5
const MAX_SIGNAL_WEIGHT = 5
const VIBE_LIST_LIMIT = 100

const Signal = Schema.Struct({
  type: Schema.Literals(["book", "author", "genre", "axiom", "audience", "format", "series", "semantic", "popularity", "user"]),
  value: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Book/author/user id, a genre key (mystery, romance, horror, historical, literary, …), axiom (magic, science, realistic), " +
        "audience (young_adult, middle_grade, children, …), format (graphic_novel, audio, …), series (first, standalone, " +
        "first_or_standalone), or free text for semantic. Omit for popularity.",
    }),
  ),
  weight: Schema.Int.check(Schema.isBetween({ maximum: MAX_SIGNAL_WEIGHT, minimum: MIN_SIGNAL_WEIGHT })),
})

const CreateVibeParams = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  privacy: Schema.optionalKey(Privacy),
  signals: Schema.optionalKey(Schema.Array(Signal)),
  title: Schema.NonEmptyString,
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

const CreateVibe = hardcoverTool({
  description:
    "Creates a custom vibe: a recommendation feed tuned by weighted signals (-5 to 5) such as books, authors, genres, or free text.",
  kind: "create",
  name: "hardcover_create_vibe",
  parameters: CreateVibeParams,
  requires: ["supporter"],
  scopes: ["write:vibes"],
  success: Schema.Struct({ vibe: Json }),
  title: "Create a vibe",
})

const VibeRows = Schema.Struct({ vibes: JsonList })

const InsertedVibe = Schema.Struct({
  insert_vibe: Payload({ vibe: Schema.Unknown }),
})

/** `VibeSignalInput`, with the fields the tool sets. */
const VibeSignalInput = Schema.Struct({
  position: Schema.Int,
  signal_type: Schema.String,
  value: Schema.optional(Schema.String),
  weight: Schema.Int,
})

/** `VibeInput`, with the fields the tool sets; omitted ones are left to Hardcover. */
const VibeInput = Schema.Struct({
  description: Schema.optional(Schema.String),
  privacy_setting_id: Schema.optional(Schema.Int),
  title: Schema.String,
  vibe_signals_attributes: Schema.optional(Schema.Array(VibeSignalInput)),
})

const vibesOf = run(
  GraphQL.query("Vibes", {
    document: `query Vibes($userId: Int!) {
      vibes(where: {user_id: {_eq: $userId}}, order_by: {updated_at: desc}, limit: ${VIBE_LIST_LIMIT}) {
        id title slug description vibe_type privacy_setting_id cached_book_ids books_generated_at
      }
    }`,
    result: VibeRows,
    variables: { userId: Schema.Int },
  }),
)

const insertVibe = run(
  GraphQL.mutation("CreateVibe", {
    document: `mutation CreateVibe($object: VibeInput!) { insert_vibe(object: $object) { id errors vibe { id title slug privacy_setting_id } } }`,
    result: InsertedVibe,
    variables: { object: VibeInput },
  }),
)

/**
 * The privacy id to store, or undefined when the caller left it to Hardcover.
 * @param {PrivacyName | undefined} privacy The privacy the caller asked for.
 * @returns {number | undefined} Hardcover's privacy id, when one was given.
 */
const vibePrivacy = (privacy: PrivacyName | undefined): number | undefined =>
  Option.getOrUndefined(Option.map(Option.fromNullishOr(privacy), privacyId))

/**
 * One signal in the shape Hardcover's nested-attributes create expects.
 * @param {typeof Signal.Type} signal The signal the caller sent.
 * @param {number} position Where the signal sits in the list.
 * @returns {typeof VibeSignalInput.Type} The signal; an omitted value is not sent.
 */
const vibeSignal = (signal: typeof Signal.Type, position: number): typeof VibeSignalInput.Type => ({
  position,
  signal_type: signal.type,
  value: signal.value,
  weight: signal.weight,
})

/**
 * The signals to send, or undefined when the caller gave none so the key is omitted.
 * @param {ReadonlyArray<typeof Signal.Type> | undefined} signals The signals the caller sent.
 * @returns {ReadonlyArray<typeof VibeSignalInput.Type> | undefined} The signals Hardcover expects.
 */
const vibeSignals = (signals: ReadonlyArray<typeof Signal.Type> | undefined): ReadonlyArray<typeof VibeSignalInput.Type> | undefined =>
  Option.getOrUndefined(Option.map(Option.fromNullishOr(signals), Arr.map(vibeSignal)))

const vibeHandlers = {
  hardcover_create_vibe: Effect.fn(function* createVibe(params: typeof CreateVibe.parametersSchema.Type) {
    const data = yield* insertVibe({
      object: {
        description: params.description,
        privacy_setting_id: vibePrivacy(params.privacy),
        title: params.title,
        vibe_signals_attributes: vibeSignals(params.signals),
      },
    })
    const inserted = yield* payload({ field: "insert_vibe", value: data.insert_vibe })
    return { vibe: inserted.vibe }
  }),

  hardcover_list_vibes: Effect.fn(function* listVibes() {
    const { hcUserId } = yield* Session
    const data = yield* vibesOf({ userId: hcUserId })
    return { vibes: data.vibes }
  }),
}

/**
 * Application module, not a public API.
 * @internal
 */
export { CreateVibe, ListVibes, vibeHandlers }
