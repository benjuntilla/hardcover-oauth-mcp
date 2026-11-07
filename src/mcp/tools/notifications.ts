/** The signed-in user's notifications, through the SDK's notifications resource. */
import { Array as Arr, Effect, Predicate, Schema } from "effect"
import { Id, JsonList, Limit, Offset, call } from "./common.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { hardcoverTool } from "#src/mcp/define.ts"

const DEFAULT_NOTIFICATIONS_LIMIT = 25
const MAX_NOTIFICATIONS_LIMIT = 100
const DEFAULT_NOTIFICATIONS_OFFSET = 0
const EMPTY_ID_COUNT = 0
const NotificationsLimit = Limit({ fallback: DEFAULT_NOTIFICATIONS_LIMIT, max: MAX_NOTIFICATIONS_LIMIT })
const NotificationIds = Schema.optionalKey(Schema.Array(Id("Notification delivery id.")))

const ListNotifications = hardcoverTool({
  description: "The user's notifications, newest first (unread only unless told otherwise), with ids to mark them read.",
  kind: "read",
  name: "hardcover_list_notifications",
  parameters: Schema.Struct({
    includeRead: Schema.optionalKey(Schema.Boolean),
    limit: NotificationsLimit,
    offset: Offset,
  }),
  scopes: ["read:notifications"],
  success: Schema.Struct({ notifications: JsonList, unread: Schema.Int }),
  title: "List notifications",
})

const MarkNotificationsRead = hardcoverTool({
  description: "Marks the given notifications (delivery ids from hardcover_list_notifications) as read, or all of them.",
  kind: "update",
  name: "hardcover_mark_notifications_read",
  parameters: Schema.Struct({
    all: Schema.optionalKey(Schema.Boolean),
    ids: NotificationIds,
  }),
  scopes: ["write:notifications"],
  success: Schema.Struct({ marked: Schema.Int }),
  title: "Mark notifications read",
})

const notificationHandlers = {
  hardcover_list_notifications: Effect.fn(function* listNotifications(params: typeof ListNotifications.parametersSchema.Type) {
    const limit = params.limit ?? DEFAULT_NOTIFICATIONS_LIMIT
    const offset = params.offset ?? DEFAULT_NOTIFICATIONS_OFFSET
    const unread = yield* call((hardcover) => hardcover.client.notifications.unreadCount())
    if (params.includeRead === true) {
      const page = yield* call((hardcover) => hardcover.client.notifications.list({ limit, offset }))
      return { notifications: page.items, unread }
    }
    const page = yield* call((hardcover) =>
      hardcover.client.graphql<{ notification_deliveries: ReadonlyArray<unknown> }>(
        `query Unread($userId: Int!, $limit: Int!, $offset: Int!) {
          notification_deliveries(where: {user_id: {_eq: $userId}, read: {_eq: false}}, order_by: [{sent_at: desc}, {id: desc}], limit: $limit, offset: $offset) {
            id read read_at sent_at notification { id title description link link_text }
          }
        }`,
        { limit, offset, userId: hardcover.userId },
      ),
    )
    return { notifications: page.notification_deliveries, unread }
  }),

  hardcover_mark_notifications_read: Effect.fn(function* markNotificationsRead(params: typeof MarkNotificationsRead.parametersSchema.Type) {
    if (params.all === true) {
      const marked = yield* call((hardcover) => hardcover.client.notifications.markRead())
      return { marked }
    }
    if (Predicate.isUndefined(params.ids) || Arr.length(params.ids) === EMPTY_ID_COUNT) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Pass ids, or all: true." })
    }
    const ids = params.ids ?? []
    const marked = yield* call((hardcover) => hardcover.client.notifications.markRead(Arr.copy(ids)))
    return { marked }
  }),
}

/**
 * Application module, not a public API.
 * @internal
 */
export { ListNotifications, MarkNotificationsRead, notificationHandlers }
