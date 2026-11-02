/** Reading goals, through the SDK's goals resource. */
import { Array as Arr, Effect, Option, Predicate, Schema, Struct, pipe } from "effect"
import { DateString, GOAL_METRIC, Id, Json, JsonList, Privacy, call, privacySetting } from "#src/mcp/tools/common.ts"
import type { Goal, GoalConditionInput, GoalProgress, GoalsResource } from "@hardcover/sdk"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Toolkit } from "effect/ai"
import { defined } from "./sdk-fields.ts"
import { goalProgress } from "@hardcover/sdk"
import { hardcoverTool } from "#src/mcp/define.ts"

const MIN_TARGET = 1
const BOOK_METRIC = "book"

const CategoryIds = Schema.Array(Schema.Int).annotate({
  description:
    "Only count these categories: 1 Book, 2 Novella, 3 Short Story, 4 Graphic Novel, 5 Fan Fiction, 6 Research Paper, 7 Poetry, 8 Collection, 9 Web Novel, 10 Light Novel.",
})
const FormatId = Schema.Int.annotate({ description: "Only count this format: 1 Physical, 2 Audio, 3 Both, 4 Ebook." })

const Conditions = Schema.Struct({
  bookCategoryIds: Schema.optionalKey(CategoryIds),
  readingFormatId: Schema.optionalKey(FormatId),
}).annotate({ description: "Optional filters on what counts toward the goal." })

const Metric = Schema.Literals(["book", "page"]).annotate({ description: "What to count: books (default) or pages." })
const Target = Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_TARGET))
const OptionalConditions = Schema.optionalKey(Conditions)
const OptionalDescription = Schema.optionalKey(Schema.String)
const OptionalMetric = Schema.optionalKey(Metric)
const OptionalPrivacy = Schema.optionalKey(Privacy)
const OptionalDate = Schema.optionalKey(DateString("Date"))
const OptionalTarget = Schema.optionalKey(Target)
const OptionalArchived = Schema.optionalKey(Schema.Boolean)

const ListGoals = hardcoverTool({
  description: "The user's reading goals with target, progress, dates, and state (active, completed, failed).",
  kind: "read",
  name: "hardcover_list_goals",
  parameters: Schema.Struct({ includeArchived: Schema.optionalKey(Schema.Boolean) }),
  scopes: ["read:goals"],
  success: Schema.Struct({ goals: JsonList }),
  title: "List your reading goals",
})

const CreateGoal = hardcoverTool({
  description: "Creates a reading goal, e.g. 52 books between 2026-01-01 and 2026-12-31.",
  kind: "create",
  name: "hardcover_create_goal",
  parameters: Schema.Struct({
    conditions: OptionalConditions,
    description: OptionalDescription,
    endDate: DateString("End"),
    metric: OptionalMetric,
    privacy: OptionalPrivacy,
    startDate: DateString("Start"),
    target: Target.annotate({ description: "How many books (or pages)." }),
  }),
  scopes: ["write:goals"],
  success: Schema.Struct({ goal: Json }),
  title: "Create a reading goal",
})

const UpdateGoal = hardcoverTool({
  description: "Changes a goal's target, dates, description, privacy, or filters, or archives it.",
  kind: "update",
  name: "hardcover_update_goal",
  parameters: Schema.Struct({
    archived: OptionalArchived,
    conditions: OptionalConditions,
    description: OptionalDescription,
    endDate: OptionalDate,
    goalId: Id("Goal id."),
    privacy: OptionalPrivacy,
    startDate: OptionalDate,
    target: OptionalTarget,
  }),
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

const defaultDescription = (target: number, metric: string, endDate: string): string =>
  `${target} ${metric === BOOK_METRIC ? "books" : "pages"} by ${endDate}`

const goalConditions = (conditions: typeof Conditions.Type | undefined): GoalConditionInput | undefined => {
  if (Predicate.isUndefined(conditions)) {
    return Option.getOrUndefined(Option.none())
  }
  const input: GoalConditionInput = {}
  if (Predicate.isNotUndefined(conditions.bookCategoryIds)) {
    input.bookCategoryIds = Arr.copy(conditions.bookCategoryIds)
  }
  if (Predicate.isNotUndefined(conditions.readingFormatId)) {
    input.readingFormatId = conditions.readingFormatId
  }
  return input
}

const withProgress = (goal: Goal): Struct.Simplify<Readonly<Goal & { readonly progressInUnit: GoalProgress }>> =>
  Struct.assign(goal, { progressInUnit: goalProgress(goal) })

const FIRST_PARAMETER = 0

const createFields = (params: typeof CreateGoal.parametersSchema.Type): Parameters<GoalsResource["create"]>[typeof FIRST_PARAMETER] => {
  const metric = params.metric ?? BOOK_METRIC
  const fields: Parameters<GoalsResource["create"]>[typeof FIRST_PARAMETER] = {
    description: params.description ?? defaultDescription(params.target, metric, params.endDate),
    endDate: params.endDate,
    goal: params.target,
    metric: GOAL_METRIC[metric],
    startDate: params.startDate,
  }
  const privacy = privacySetting(params.privacy)
  if (Predicate.isNotUndefined(privacy)) {
    fields.privacy = privacy
  }
  const conditions = goalConditions(params.conditions)
  if (Predicate.isNotUndefined(conditions)) {
    fields.conditions = conditions
  }
  return fields
}

const goalHandlers = {
  hardcover_create_goal: Effect.fn(function* createGoal(params: typeof CreateGoal.parametersSchema.Type) {
    const goal = yield* call((hardcover) => hardcover.client.goals.create(createFields(params)))
    return { goal: withProgress(goal) }
  }),

  hardcover_delete_goal: Effect.fn(function* deleteGoal({ goalId }: typeof DeleteGoal.parametersSchema.Type) {
    const goal = yield* call((hardcover) => hardcover.client.goals.get(goalId))
    if (Predicate.isNull(goal)) {
      return yield* HardcoverError.make({ kind: "not_found", message: `Goal ${goalId} is not one of your goals.` })
    }
    yield* call((hardcover) => hardcover.client.goals.delete(goalId))
    return { deleted: goalId }
  }),

  hardcover_list_goals: Effect.fn(function* listGoals({ includeArchived = false }: typeof ListGoals.parametersSchema.Type) {
    const goals = yield* call((hardcover) => hardcover.client.goals.list({ includeArchived }))
    return { goals: pipe(goals, Arr.map(withProgress)) }
  }),

  hardcover_update_goal: Effect.fn(function* editGoal(params: typeof UpdateGoal.parametersSchema.Type) {
    const patch = defined({
      archived: params.archived,
      conditions: goalConditions(params.conditions),
      description: params.description,
      endDate: params.endDate,
      goal: params.target,
      privacy: privacySetting(params.privacy),
      startDate: params.startDate,
    })
    const goal = yield* call((hardcover) => hardcover.client.goals.update(params.goalId, patch))
    return { goal: withProgress(goal) }
  }),
}

const GoalsToolkit = Toolkit.make(ListGoals, CreateGoal, UpdateGoal, DeleteGoal)
const GoalsToolkitLive = GoalsToolkit.toLayer(goalHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { GoalsToolkit, GoalsToolkitLive }
