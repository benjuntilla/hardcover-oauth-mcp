/** Other readers and follows. */
import { Array as Arr, Effect, Schema, String as Str, Struct, pipe } from "effect"
import { Json, JsonList, Limit, Offset, Payload, first, payload, run } from "./common.ts"
import { ListNotifications, MarkNotificationsRead, notificationHandlers } from "./notifications.ts"
import { Me, profileHandlers } from "./profile.ts"
import { GraphQL } from "effect/graphql"
import { Session } from "#src/mcp/session.ts"
import { Toolkit } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"

const DEFAULT_FOLLOWS_LIMIT = 50
const MAX_FOLLOWS_LIMIT = 200
const DEFAULT_FOLLOWS_OFFSET = 0
const LEADING_AT = /^@/v

const Username = Schema.NonEmptyString.annotate({ description: "Hardcover username, with or without @." })

const UsernameParams = Schema.Struct({ username: Username })

const FollowDirection = Schema.Literals(["following", "followers"])

const ListFollowsParams = Schema.Struct({
  direction: Schema.optionalKey(FollowDirection.annotate({ description: "Default following." })),
  limit: Limit({ fallback: DEFAULT_FOLLOWS_LIMIT, max: MAX_FOLLOWS_LIMIT }),
  offset: Offset,
})

const GetUser = hardcoverTool({
  description: "A Hardcover user's public profile by username: id, name, bio, counts, Supporter badge.",
  kind: "read",
  name: "hardcover_get_user",
  parameters: UsernameParams,
  scopes: ["read:users"],
  success: Schema.Struct({ user: Json }),
  title: "Look up a reader",
})

const ListFollows = hardcoverTool({
  description: "People the user follows, or the user's followers.",
  kind: "read",
  name: "hardcover_list_follows",
  parameters: ListFollowsParams,
  scopes: ["read:social"],
  success: Schema.Struct({ users: JsonList }),
  title: "List follows",
})

const FollowUser = hardcoverTool({
  description: "Follows a Hardcover user.",
  idempotent: true,
  kind: "create",
  name: "hardcover_follow_user",
  parameters: UsernameParams,
  scopes: ["write:social", "read:users"],
  success: Schema.Struct({ following: Json }),
  title: "Follow a reader",
})

const UnfollowUser = hardcoverTool({
  description: "Stops following a Hardcover user.",
  idempotent: true,
  kind: "delete",
  name: "hardcover_unfollow_user",
  parameters: UsernameParams,
  scopes: ["write:social", "read:users"],
  success: Schema.Struct({ unfollowed: Schema.String }),
  title: "Unfollow a reader",
})

const UserProfile = Schema.Struct({
  id: Schema.Finite,
  username: Schema.String,
})

const UsersData = Schema.Struct({ users: Schema.Array(Schema.Unknown) })

const FollowRow = Schema.Struct({
  created_at: Schema.NullOr(Schema.String),
  followed_user: Schema.optionalKey(Schema.Unknown),
  user: Schema.optionalKey(Schema.Unknown),
})

const FollowsData = Schema.Struct({ followed_users: Schema.Array(FollowRow) })

const Followed = Schema.Struct({
  insert_followed_user: Payload({ followed_user: Schema.Unknown }),
})

const Unfollowed = Schema.Struct({
  delete_followed_user: Payload({ id: Schema.NullOr(Schema.Int) }),
})

const PageVariables = { limit: Schema.Int, offset: Schema.Int, userId: Schema.Int }

const usersNamed = run(
  GraphQL.query("User", {
    document: `query User($username: citext!) {
      users(where: {username: {_eq: $username}}, limit: 1) {
        id username name bio location flair pro books_count followers_count followed_users_count image { url }
      }
    }`,
    result: UsersData,
    variables: { username: Schema.String },
  }),
)

const followingOf = run(
  GraphQL.query("Following", {
    document: `query Following($userId: Int!, $limit: Int!, $offset: Int!) {
      followed_users(where: {user_id: {_eq: $userId}}, order_by: {created_at: desc_nulls_last}, limit: $limit, offset: $offset) {
        created_at followed_user { id username name }
      }
    }`,
    result: FollowsData,
    variables: PageVariables,
  }),
)

const followersOf = run(
  GraphQL.query("Followers", {
    document: `query Followers($userId: Int!, $limit: Int!, $offset: Int!) {
      followed_users(where: {followed_user_id: {_eq: $userId}}, order_by: {created_at: desc_nulls_last}, limit: $limit, offset: $offset) {
        created_at user { id username name }
      }
    }`,
    result: FollowsData,
    variables: PageVariables,
  }),
)

const follow = run(
  GraphQL.mutation("Follow", {
    document: `mutation Follow($userId: Int!) { insert_followed_user(user_id: $userId) { id error followed_user { id username } } }`,
    result: Followed,
    variables: { userId: Schema.Int },
  }),
)

const unfollow = run(
  GraphQL.mutation("Unfollow", {
    document: `mutation Unfollow($userId: Int!) { delete_followed_user(user_id: $userId) { id error } }`,
    result: Unfollowed,
    variables: { userId: Schema.Int },
  }),
)

/**
 * A username without a leading @.
 * @param {string} username The username the caller sent.
 * @returns {string} The username Hardcover stores.
 */
const bareUsername = (username: string): string => pipe(username, Str.replace(LEADING_AT, ""))

/**
 * The public profile of a user, or `not_found`.
 * @param {string} username The username, with or without @.
 * @returns {Effect.Effect<typeof UserProfile.Type, HardcoverError, Session>} The user.
 */
const userByName = Effect.fn(function* lookupUser(username: string) {
  const name = bareUsername(username)
  const data = yield* usersNamed({ username: name })
  const row = yield* first({ rows: data.users, what: `user @${name}` })
  return yield* Schema.decodeUnknownEffect(UserProfile)(row).pipe(
    Effect.catchTag("SchemaError", () => Effect.die("Hardcover's response to User did not match the expected shape")),
  )
})

/**
 * One follow row as the tool returns it: when it started, and the other person.
 * @param {typeof FollowRow.Type} row A followed_users row.
 * @returns {{ since: string | null, user: unknown }} The row.
 */
const followEntry = (row: typeof FollowRow.Type): { readonly since: string | null; readonly user: unknown } => ({
  since: row.created_at,
  user: row.followed_user ?? row.user,
})

const socialHandlers = {
  hardcover_follow_user: Effect.fn(function* followUser({ username }: typeof FollowUser.parametersSchema.Type) {
    const user = yield* userByName(username)
    const data = yield* follow({ userId: user.id })
    const followed = yield* payload({ field: "insert_followed_user", value: data.insert_followed_user })
    return { following: followed.followed_user }
  }),

  hardcover_get_user: Effect.fn(function* getUser({ username }: typeof GetUser.parametersSchema.Type) {
    return { user: yield* userByName(username) }
  }),

  hardcover_list_follows: Effect.fn(function* listFollows({
    direction = "following",
    limit = DEFAULT_FOLLOWS_LIMIT,
    offset = DEFAULT_FOLLOWS_OFFSET,
  }: typeof ListFollows.parametersSchema.Type) {
    const { hcUserId } = yield* Session
    const follows = direction === "following" ? followingOf : followersOf
    const data = yield* follows({ limit, offset, userId: hcUserId })
    return {
      users: pipe(
        data.followed_users,
        Arr.map((row) => followEntry(row)),
      ),
    }
  }),

  hardcover_unfollow_user: Effect.fn(function* unfollowUser({ username }: typeof UnfollowUser.parametersSchema.Type) {
    const user = yield* userByName(username)
    const data = yield* unfollow({ userId: user.id })
    yield* payload({ field: "delete_followed_user", value: data.delete_followed_user })
    return { unfollowed: user.username }
  }),
}

/** The connected account, other readers, follows, and notifications. */
const PeopleToolkit = Toolkit.make(Me, GetUser, ListFollows, FollowUser, UnfollowUser, ListNotifications, MarkNotificationsRead)
const PeopleToolkitLive = PeopleToolkit.toLayer(pipe(profileHandlers, Struct.assign(socialHandlers), Struct.assign(notificationHandlers)))

/**
 * Application module, not a public API.
 * @internal
 */
export { PeopleToolkit, PeopleToolkitLive }
