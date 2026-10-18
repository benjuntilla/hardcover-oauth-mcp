/** Reading goals. Read: read:goals. Write: write:goals. */
import type { CreatedGoalRow, Goal } from "#src/mcp/tools/goal-operations.ts"
import { DateString, Id, Json, JsonList, Privacy, payload, privacyId } from "#src/mcp/tools/common.ts"
import { Effect, Option, Predicate, Schema } from "effect"
import { goalById, goalsOf, insertGoal, removeGoal, updateGoal } from "#src/mcp/tools/goal-operations.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"
import { Toolkit } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"

const MIN_TARGET = 1
const EMPTY_CONDITIONS: Readonly<Record<string, unknown>> = {}
const EMPTY_DESCRIPTION = ""
const BOOK_METRIC = "book"

/** The goal fields an update replaces; undefined keeps the stored value. */
type GoalChanges = { readonly [Key in keyof Goal]?: Goal[Key] | undefined }

const Conditions = Schema.Struct({
  bookCategoryIds: Schema.optionalKey(
    Schema.Array(Schema.Int).annotate({
      description:
        "Only count these categories: 1 Book, 2 Novella, 3 Short Story, 4 Graphic Novel, 5 Fan Fiction, 6 Research Paper, 7 Poetry, 8 Collection, 9 Web Novel, 10 Light Novel.",
    }),
  ),
  readingFormatId: Schema.optionalKey(
    Schema.Int.annotate({ description: "Only count this format: 1 Physical, 2 Audio, 3 Both, 4 Ebook." }),
  ),
}).annotate({ description: "Optional filters on what counts toward the goal." })

const Metric = Schema.Literals(["book", "page"]).annotate({ description: "What to count: books (default) or pages." })

const Target = Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_TARGET))

const ListGoalsParams = Schema.Struct({ includeArchived: Schema.optionalKey(Schema.Boolean) })

const CreateGoalParams = Schema.Struct({
  conditions: Schema.optionalKey(Conditions),
  description: Schema.optionalKey(Schema.String.annotate({ description: "Default '<target> <metric> by <end date>'." })),
  endDate: DateString("End"),
  metric: Schema.optionalKey(Metric),
  privacy: Schema.optionalKey(Privacy),
  startDate: DateString("Start"),
  target: Target.annotate({ description: "How many books (or pages)." }),
})

const UpdateGoalParams = Schema.Struct({
  archived: Schema.optionalKey(Schema.Boolean),
  conditions: Schema.optionalKey(Conditions),
  description: Schema.optionalKey(Schema.String),
  endDate: Schema.optionalKey(DateString("End")),
  goalId: Id("Goal id."),
  privacy: Schema.optionalKey(Privacy),
  startDate: Schema.optionalKey(DateString("Start")),
  target: Schema.optionalKey(Target),
})

const ListGoals = hardcoverTool({
  description: "The user's reading goals with target, progress, dates, and state (active, completed, failed).",
  kind: "read",
  name: "hardcover_list_goals",
  parameters: ListGoalsParams,
  scopes: ["read:goals"],
  success: Schema.Struct({ goals: JsonList }),
  title: "List your reading goals",
})

const CreateGoal = hardcoverTool({
  description: "Creates a reading goal, e.g. 52 books between 2026-01-01 and 2026-12-31.",
  kind: "create",
  name: "hardcover_create_goal",
  parameters: CreateGoalParams,
  scopes: ["write:goals"],
  success: Schema.Struct({ goal: Json }),
  title: "Create a reading goal",
})

const UpdateGoal = hardcoverTool({
  description: "Changes a goal's target, dates, description, privacy, or filters, or archives it.",
  kind: "update",
  name: "hardcover_update_goal",
  parameters: UpdateGoalParams,
  scopes: ["write:goals", "read:goals"],
  success: Schema.Struct({ goal: Json }),
  title: "Edit a reading goal",
})

const DeleteGoal = hardcoverTool({
  description: "Deletes one of the user's reading goals.",
  kind: "delete",
  name: "hardcover_delete_goal",
  parameters: Schema.Struct({ goalId: Id("Goal id.") }),
  scopes: ["write:goals", "read:goals"],
  success: Schema.Struct({ deleted: Schema.Int }),
  title: "Delete a reading goal",
})

/**
 * The goal when it belongs to the signed-in user, else none.
 * @param {Goal | null} goal The row Hardcover returned.
 * @param {number} userId The signed-in user's Hardcover id.
 * @returns {Option.Option<Goal>} The goal, when it is theirs.
 */
const ownedGoal = (goal: Goal | null, userId: number): Option.Option<Goal> =>
  Predicate.isNotNull(goal) && goal.user_id === userId ? Option.some(goal) : Option.none()

/**
 * The signed-in user's goal, or `not_found`.
 * @param {number} goalId The goal id.
 * @returns {Effect.Effect<Goal, HardcoverError, Session>} The goal.
 */
const loadOwnGoal = Effect.fn(function* loadGoal(goalId: number) {
  const { hcUserId } = yield* Session
  const data = yield* goalById({ id: goalId })
  return yield* Option.match(ownedGoal(data.goals_by_pk, hcUserId), {
    onNone: () => HardcoverError.make({ kind: "not_found", message: `Goal ${goalId} is not one of your goals.` }),
    onSome: Effect.succeed,
  })
})

/**
 * `update_goal` takes the complete goal, so unchanged fields are sent back as they are.
 * @param {object} options The stored goal and the fields to replace.
 * @param {Goal} options.goal The goal as Hardcover has it.
 * @param {GoalChanges} options.changes The fields the caller wants changed.
 * @returns {Effect.Effect<unknown, HardcoverError, Session>} The updated goal.
 */
const saveGoal = (options: Readonly<{ changes: GoalChanges; goal: CreatedGoalRow }>): Effect.Effect<unknown, HardcoverError, Session> =>
  Effect.gen(function* saveGoalChanges() {
    const { changes, goal } = options
    const object = {
      archived: changes.archived ?? goal.archived,
      conditions: changes.conditions ?? goal.conditions ?? EMPTY_CONDITIONS,
      description: changes.description ?? goal.description ?? EMPTY_DESCRIPTION,
      end_date: changes.end_date ?? goal.end_date,
      goal: changes.goal ?? goal.goal,
      metric: goal.metric,
      privacy_setting_id: changes.privacy_setting_id ?? Option.getOrUndefined(Option.fromNullishOr(goal.privacy_setting_id)),
      start_date: changes.start_date ?? goal.start_date,
    }
    const data = yield* updateGoal({ id: goal.id, object })
    const updated = yield* payload({ field: "update_goal", value: data.update_goal })
    return updated.goal
  })

/**
 * The default description Hardcover shows when the caller gives none.
 * @param {number} target How many books or pages.
 * @param {string} metric Whether books or pages are counted.
 * @param {string} endDate When the goal ends.
 * @returns {string} The description.
 */
const defaultDescription = (target: number, metric: string, endDate: string): string =>
  `${target} ${metric === BOOK_METRIC ? "books" : "pages"} by ${endDate}`

/**
 * The privacy id the caller asked for, or none when they left it unchanged.
 * @param {PrivacyName | undefined} privacy The privacy the caller asked for.
 * @returns {Option.Option<number>} Hardcover's privacy id, when one was given.
 */
const privacySetting = (privacy: "public" | "followers" | "private" | undefined): Option.Option<number> =>
  Option.map(Option.fromNullishOr(privacy), privacyId)

/**
 * The fields of a goal the caller asked to change, with omitted ones left out.
 * @param {typeof UpdateGoalParams.Type} params The update the caller sent.
 * @returns {GoalChanges} The changes; fields the caller did not set are undefined.
 */
const goalChanges = (params: typeof UpdateGoalParams.Type): GoalChanges => ({
  archived: params.archived,
  conditions: params.conditions,
  description: params.description,
  end_date: params.endDate,
  goal: params.target,
  privacy_setting_id: Option.getOrUndefined(privacySetting(params.privacy)),
  start_date: params.startDate,
})

const goalHandlers = {
  hardcover_create_goal: Effect.fn(function* createGoal(params: typeof CreateGoal.parametersSchema.Type) {
    const metric = params.metric ?? BOOK_METRIC
    const data = yield* insertGoal({
      object: {
        conditions: params.conditions ?? EMPTY_CONDITIONS,
        description: params.description ?? defaultDescription(params.target, metric, params.endDate),
        end_date: params.endDate,
        goal: params.target,
        metric,
        start_date: params.startDate,
      },
    })
    const { goal } = yield* payload({ field: "insert_goal", value: data.insert_goal })
    // Insert_goal ignores privacy_setting_id and makes the goal public; update_goal honours it.
    if (Predicate.isNotUndefined(params.privacy) && goal.privacy_setting_id !== privacyId(params.privacy)) {
      return { goal: yield* saveGoal({ changes: { privacy_setting_id: privacyId(params.privacy) }, goal }) }
    }
    return { goal }
  }),

  hardcover_delete_goal: Effect.fn(function* deleteGoal({ goalId }: typeof DeleteGoal.parametersSchema.Type) {
    yield* loadOwnGoal(goalId)
    const data = yield* removeGoal({ id: goalId })
    yield* payload({ field: "delete_goal", value: data.delete_goal })
    return { deleted: goalId }
  }),

  hardcover_list_goals: Effect.fn(function* listGoals({ includeArchived = false }: typeof ListGoals.parametersSchema.Type) {
    const { hcUserId } = yield* Session
    const data = yield* goalsOf({ archived: includeArchived ? [false, true] : [false], userId: hcUserId })
    return { goals: data.goals }
  }),

  hardcover_update_goal: Effect.fn(function* editGoal(params: typeof UpdateGoal.parametersSchema.Type) {
    const goal = yield* loadOwnGoal(params.goalId)
    return { goal: yield* saveGoal({ changes: goalChanges(params), goal }) }
  }),
}

const GoalsToolkit = Toolkit.make(ListGoals, CreateGoal, UpdateGoal, DeleteGoal)
const GoalsToolkitLive = GoalsToolkit.toLayer(goalHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { GoalsToolkit, GoalsToolkitLive }
