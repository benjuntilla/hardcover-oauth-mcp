/** The GraphQL operations behind the reading-goal tools. */
import { JsonList, Payload, run } from "#src/mcp/tools/common.ts"
import { GraphQL } from "effect/graphql"
import { Schema } from "effect"

const GOAL_FIELDS = "id goal metric progress start_date end_date state description conditions privacy_setting_id archived completed_at"
const GoalConditions = Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))

const GoalRow = Schema.Struct({
  archived: Schema.Boolean,
  conditions: GoalConditions,
  description: Schema.NullOr(Schema.String),
  end_date: Schema.String,
  goal: Schema.Finite,
  id: Schema.Finite,
  metric: Schema.String,
  privacy_setting_id: Schema.NullOr(Schema.Finite),
  start_date: Schema.String,
  user_id: Schema.Finite,
})

const GoalLookup = Schema.Struct({ goals_by_pk: Schema.NullOr(GoalRow) })
const GoalRows = Schema.Struct({ goals: JsonList })

/** The fields of a new goal that the privacy follow-up reads. */
const CreatedGoal = Schema.Struct({
  archived: Schema.Boolean,
  conditions: Schema.optionalKey(GoalConditions),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  end_date: Schema.String,
  goal: Schema.Finite,
  id: Schema.Finite,
  metric: Schema.String,
  privacy_setting_id: Schema.NullOr(Schema.Finite),
  start_date: Schema.String,
})

const InsertedGoal = Schema.Struct({ insert_goal: Payload({ goal: CreatedGoal }) })
const UpdatedGoal = Schema.Struct({ update_goal: Payload({ goal: Schema.Unknown }) })
const DeletedGoal = Schema.Struct({ delete_goal: Payload({ id: Schema.NullOr(Schema.Int) }) })

/** `GoalInput`: `update_goal` takes the whole goal, `insert_goal` a new one. */
const GoalInput = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
  conditions: Schema.Record(Schema.String, Schema.Unknown),
  description: Schema.String,
  end_date: Schema.String,
  goal: Schema.Finite,
  metric: Schema.String,
  privacy_setting_id: Schema.optional(Schema.Finite),
  start_date: Schema.String,
})

const goalById = run(
  GraphQL.query("Goal", {
    document: `query Goal($id: Int!) { goals_by_pk(id: $id) { ${GOAL_FIELDS} user_id } }`,
    result: GoalLookup,
    variables: { id: Schema.Int },
  }),
)

const goalsOf = run(
  GraphQL.query("Goals", {
    document: `query Goals($userId: Int!, $archived: [Boolean!]!) {
      goals(where: {user_id: {_eq: $userId}, archived: {_in: $archived}}, order_by: {end_date: desc}) { ${GOAL_FIELDS} }
    }`,
    result: GoalRows,
    variables: { archived: Schema.Array(Schema.Boolean), userId: Schema.Int },
  }),
)

const insertGoal = run(
  GraphQL.mutation("CreateGoal", {
    document: `mutation CreateGoal($object: GoalInput!) { insert_goal(object: $object) { id errors goal { ${GOAL_FIELDS} } } }`,
    result: InsertedGoal,
    variables: { object: GoalInput },
  }),
)

const updateGoal = run(
  GraphQL.mutation("UpdateGoal", {
    document: `mutation UpdateGoal($id: Int!, $object: GoalInput!) { update_goal(id: $id, object: $object) { id errors goal { ${GOAL_FIELDS} } } }`,
    result: UpdatedGoal,
    variables: { id: Schema.Int, object: GoalInput },
  }),
)

const removeGoal = run(
  GraphQL.mutation("DeleteGoal", {
    document: `mutation DeleteGoal($id: Int!) { delete_goal(id: $id) { id errors } }`,
    result: DeletedGoal,
    variables: { id: Schema.Int },
  }),
)

type Goal = typeof GoalRow.Type
type CreatedGoalRow = typeof CreatedGoal.Type

/**
 * Application module, not a public API.
 * @internal
 */
export { goalById, goalsOf, insertGoal, removeGoal, updateGoal }
/**
 * Application module, not a public API.
 * @internal
 */
export type { CreatedGoalRow, Goal }
