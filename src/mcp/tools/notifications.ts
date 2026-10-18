/** The signed-in user's notifications. Read: read:notifications. Write: write:notifications. */
import { Array as Arr, DateTime, Effect, Predicate, Schema, String as Str, pipe } from "effect"
import { Id, JsonList, Limit, Offset, run } from "./common.ts"
import { GraphQL } from "effect/graphql"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"
import { hardcoverTool } from "#src/mcp/define.ts"

const DEFAULT_NOTIFICATIONS_LIMIT = 25
const MAX_NOTIFICATIONS_LIMIT = 100
const DEFAULT_NOTIFICATIONS_OFFSET = 0
const EMPTY_ID_COUNT = 0
const NO_NOTIFICATIONS = 0
const UTC_SUFFIX = /Z$/v

const NotificationId = Id("Notification delivery id.")

const ListNotificationsParams = Schema.Struct({
  includeRead: Schema.optionalKey(Schema.Boolean),
  limit: Limit({ fallback: DEFAULT_NOTIFICATIONS_LIMIT, max: MAX_NOTIFICATIONS_LIMIT }),
  offset: Offset,
})

const MarkNotificationsParams = Schema.Struct({
  all: Schema.optionalKey(Schema.Boolean),
  ids: Schema.optionalKey(Schema.Array(NotificationId)),
})

const ListNotifications = hardcoverTool({
  description: "The user's notifications, newest first (unread only unless told otherwise), with ids to mark them read.",
  kind: "read",
  name: "hardcover_list_notifications",
  parameters: ListNotificationsParams,
  scopes: ["read:notifications"],
  success: Schema.Struct({ notifications: JsonList, unread: Schema.Int }),
  title: "List notifications",
})

const MarkNotificationsRead = hardcoverTool({
  description: "Marks the given notifications (delivery ids from hardcover_list_notifications) as read, or all of them.",
  kind: "update",
  name: "hardcover_mark_notifications_read",
  parameters: MarkNotificationsParams,
  scopes: ["write:notifications"],
  success: Schema.Struct({ marked: Schema.Int }),
  title: "Mark notifications read",
})

const UnreadCount = Schema.Struct({ count: Schema.Finite })

const NotificationsData = Schema.Struct({
  notification_deliveries: JsonList,
  notification_deliveries_aggregate: Schema.Struct({ aggregate: Schema.NullOr(UnreadCount) }),
})

const MarkedNotifications = Schema.Struct({
  update_notification_deliveries: Schema.NullOr(Schema.Struct({ affected_rows: Schema.Finite })),
})

const DELIVERY_FIELDS =
  "id read read_at sent_at notification { id title description link link_text created_at notifierUser { id username } }"
const DELIVERY_ORDER = "order_by: [{sent_at: desc_nulls_last}, {id: desc}], limit: $limit, offset: $offset"
const UNREAD_COUNT = "notification_deliveries_aggregate(where: {user_id: {_eq: $userId}, read: {_eq: false}}) { aggregate { count } }"
const PageVariables = { limit: Schema.Int, offset: Schema.Int, userId: Schema.Int }

const unreadNotifications = run(
  GraphQL.query("Notifications", {
    document: `query Notifications($userId: Int!, $limit: Int!, $offset: Int!) {
      notification_deliveries(where: {user_id: {_eq: $userId}, read: {_eq: false}}, ${DELIVERY_ORDER}) { ${DELIVERY_FIELDS} }
      ${UNREAD_COUNT}
    }`,
    result: NotificationsData,
    variables: PageVariables,
  }),
)

const allNotifications = run(
  GraphQL.query("Notifications", {
    document: `query Notifications($userId: Int!, $limit: Int!, $offset: Int!) {
      notification_deliveries(where: {user_id: {_eq: $userId}}, ${DELIVERY_ORDER}) { ${DELIVERY_FIELDS} }
      ${UNREAD_COUNT}
    }`,
    result: NotificationsData,
    variables: PageVariables,
  }),
)

const markAllRead = run(
  GraphQL.mutation("MarkAllRead", {
    document: `mutation MarkAllRead($userId: Int!, $readAt: timestamp!) {
      update_notification_deliveries(where: {user_id: {_eq: $userId}, read: {_eq: false}}, _set: {read: true, read_at: $readAt}) { affected_rows }
    }`,
    result: MarkedNotifications,
    variables: { readAt: Schema.String, userId: Schema.Int },
  }),
)

const markRead = run(
  GraphQL.mutation("MarkRead", {
    document: `mutation MarkRead($userId: Int!, $ids: [bigint!]!, $readAt: timestamp!) {
      update_notification_deliveries(where: {user_id: {_eq: $userId}, id: {_in: $ids}}, _set: {read: true, read_at: $readAt}) { affected_rows }
    }`,
    result: MarkedNotifications,
    variables: { ids: Schema.Array(Schema.Int), readAt: Schema.String, userId: Schema.Int },
  }),
)

/**
 * The current UTC time without a zone suffix, as notification_deliveries.read_at expects.
 * @returns {Effect.Effect<string>} The timestamp.
 */
const nowTimestamp = (): Effect.Effect<string> =>
  Effect.gen(function* currentTimestamp() {
    const now = yield* DateTime.now
    return pipe(now, DateTime.formatIso, Str.replace(UTC_SUFFIX, ""))
  })

/**
 * Whether the caller asked to mark every unread notification.
 * @param {boolean | undefined} all The caller's `all` flag.
 * @returns {boolean} True when every unread notification should be marked.
 */
const marksAll = (all: boolean | undefined): boolean => Predicate.isBoolean(all) && all

/**
 * Whether the caller named at least one notification to mark read.
 * @param {ReadonlyArray<number> | undefined} ids The delivery ids, when given.
 * @returns {boolean} True when at least one id was given.
 */
const hasIds = (ids: ReadonlyArray<number> | undefined): ids is ReadonlyArray<number> =>
  Predicate.isNotUndefined(ids) && Arr.length(ids) > EMPTY_ID_COUNT

const notificationHandlers = {
  hardcover_list_notifications: Effect.fn(function* listNotifications({
    includeRead = false,
    limit = DEFAULT_NOTIFICATIONS_LIMIT,
    offset = DEFAULT_NOTIFICATIONS_OFFSET,
  }: typeof ListNotifications.parametersSchema.Type) {
    const { hcUserId } = yield* Session
    const notifications = includeRead ? allNotifications : unreadNotifications
    const data = yield* notifications({ limit, offset, userId: hcUserId })
    return {
      notifications: data.notification_deliveries,
      unread: data.notification_deliveries_aggregate.aggregate?.count ?? NO_NOTIFICATIONS,
    }
  }),

  hardcover_mark_notifications_read: Effect.fn(function* markNotificationsRead({
    all,
    ids,
  }: typeof MarkNotificationsRead.parametersSchema.Type) {
    const { hcUserId } = yield* Session
    if (marksAll(all)) {
      const data = yield* markAllRead({ readAt: yield* nowTimestamp(), userId: hcUserId })
      return { marked: data.update_notification_deliveries?.affected_rows ?? NO_NOTIFICATIONS }
    }
    if (!hasIds(ids)) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Pass ids, or all: true." })
    }
    const data = yield* markRead({ ids, readAt: yield* nowTimestamp(), userId: hcUserId })
    return { marked: data.update_notification_deliveries?.affected_rows ?? NO_NOTIFICATIONS }
  }),
}

/**
 * Application module, not a public API.
 * @internal
 */
export { ListNotifications, MarkNotificationsRead, notificationHandlers }
