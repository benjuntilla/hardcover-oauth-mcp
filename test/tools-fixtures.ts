/** Plausible Hardcover data per root field for the fake client; anything else gets a generic success payload. */
import { Array as Arr, Option, Record as Rec, Schema, Struct, pipe } from "effect"

type Fixture = (variables: Readonly<Record<string, unknown>>) => unknown

/** Hardcover's JSON `null`, which the fixtures answer with where Hardcover does. */
const JSON_NULL = Option.getOrNull(Option.none())

const ME = 42
/** Dune, the book most fixtures are about. */
const DUNE_ID = 100
/** Edition 11 is in the Owned list. */
const OWNED_EDITION_ID = 11

const read = {
  edition: { audio_seconds: JSON_NULL, id: 10, pages: 300 },
  editionId: 10,
  finished_at: JSON_NULL,
  id: 5,
  progress_pages: 10,
  progress_seconds: JSON_NULL,
  started_at: "2026-01-02",
}

const entry = {
  book: { audio_seconds: JSON_NULL, id: DUNE_ID, pages: 300, title: "Dune" },
  bookId: DUNE_ID,
  edition: { audio_seconds: JSON_NULL, id: 10, pages: 300 },
  editionId: 10,
  hasReview: false,
  id: 1,
  owned: false,
  statusId: 2,
  userBookReads: [read],
}

const GENERIC_PAYLOAD = { error: JSON_NULL, errors: JSON_NULL, id: 1, success: true }

const SlateDocument = Schema.Struct({ children: Schema.Array(Schema.Unknown) })
const Slate = Schema.Struct({ document: SlateDocument })
const ReviewSlate = Schema.Struct({ object: Schema.Struct({ review_slate: Slate }) })

const GoalObject = Schema.Struct({ object: Schema.Record(Schema.String, Schema.Unknown) })

/**
 * Like Hardcover: nulls are ignored, so the entry keeps its review until an empty review_slate is sent.
 * @param {Readonly<Record<string, unknown>>} variables The `update_user_book` variables.
 * @returns {boolean} Whether the entry still has a review.
 */
const keepsReview = (variables: Readonly<Record<string, unknown>>): boolean =>
  pipe(
    Schema.decodeUnknownOption(ReviewSlate)(variables),
    Option.match({ onNone: () => true, onSome: (decoded) => Arr.isReadonlyArrayNonEmpty(decoded.object.review_slate.document.children) }),
  )

/**
 * Like Hardcover, new goals come back public whatever privacy was sent.
 * @param {Readonly<Record<string, unknown>>} variables The `insert_goal` variables.
 * @returns {Readonly<Record<string, unknown>>} The stored goal.
 */
const GOAL_DEFAULTS = {
  archived: false,
  description: "52 books",
  end_date: "2026-12-31",
  goal: 10,
  id: 4,
  metric: "book",
  privacy_setting_id: 1,
  progress: 0,
  start_date: "2026-01-01",
}

const insertedGoal = (variables: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const decoded = pipe(
    Schema.decodeUnknownOption(GoalObject)(variables),
    Option.match({ onNone: () => ({}), onSome: (goal) => goal.object }),
  )
  return Struct.assign(Struct.assign(GOAL_DEFAULTS, decoded), { archived: false, id: 4 })
}

const FIXTURES: Readonly<Record<string, Fixture>> = {
  authors: () => [{ id: 1, name: "Frank Herbert" }],
  authors_by_pk: () => ({ id: 1, name: "Frank Herbert" }),
  books: () => [{ id: DUNE_ID, slug: "dune", title: "Dune" }],
  books_by_pk: () => ({ id: DUNE_ID, slug: "dune", title: "Dune" }),
  books_trending: () => ({ error: JSON_NULL, ids: [DUNE_ID] }),
  delete_followedUser: () => ({ error: JSON_NULL, id: 1 }),
  delete_goal: () => ({ errors: JSON_NULL, id: JSON_NULL }),
  delete_list: () => ({ success: true }),
  delete_list_book: () => ({ id: 31, list_id: 3 }),
  delete_reading_journal: () => ({ id: 9 }),
  delete_user_book: () => ({ bookId: DUNE_ID, id: 1 }),
  delete_user_book_read: () => ({ error: JSON_NULL, id: 5 }),
  edition_owned: () => ({ id: 40, listBook: { id: 40, list_id: 8 } }),
  editions: () => [{ bookId: DUNE_ID, id: 10 }],
  editions_by_pk: () => ({ bookId: DUNE_ID, id: 10 }),
  followed_lists: () => [],
  followed_users: () => [{ created_at: "2026-01-01", followed_user: { id: 7, username: "friend" }, user: { id: 7, username: "friend" } }],
  goals: () => [
    {
      description: "52 books",
      end_date: "2026-12-31",
      goal: 52,
      id: 4,
      metric: "book",
      progress: 0,
      start_date: "2026-01-01",
      user_id: ME,
    },
  ],
  goals_by_pk: () => ({
    archived: false,
    conditions: {},
    description: "52 books",
    end_date: "2026-12-31",
    goal: 52,
    id: 4,
    metric: "book",
    privacy_setting_id: 1,
    progress: 0,
    start_date: "2026-01-01",
    state: "active",
    user_id: ME,
  }),
  insert_followed_user: () => ({ error: JSON_NULL, followed_user: { id: 7, username: "friend" }, id: 1 }),
  insert_goal: (variables) => ({ errors: JSON_NULL, goal: insertedGoal(variables), id: 4 }),
  insert_list: () => ({ errors: JSON_NULL, id: 3, list: { id: 3 } }),
  insert_list_book: () => ({ id: 33, listBook: { id: 33 } }),
  insert_reading_journal: () => ({ errors: JSON_NULL, id: 9, readingJournal: { id: 9 } }),
  insert_user_book: () => ({ error: JSON_NULL, id: 1, userBook: entry }),
  insert_user_book_read: () => ({ error: JSON_NULL, id: 6, userBookRead: read }),
  insert_vibe: () => ({ errors: JSON_NULL, id: 12, vibe: { id: 12 } }),
  list_books: () => [
    { book_id: DUNE_ID, id: 31, position: 1 },
    { book_id: 101, id: 32, position: 2 },
  ],
  lists: () => [
    {
      id: 3,
      listBooks: [{ bookId: DUNE_ID, book_id: DUNE_ID, edition: { id: OWNED_EDITION_ID }, id: 77 }],
      list_books: [{ bookId: DUNE_ID, book_id: DUNE_ID, edition: { id: OWNED_EDITION_ID }, id: 77 }],
      name: "Owned",
      slug: "owned",
    },
  ],
  lists_by_pk: () => ({
    description: JSON_NULL,
    featured_profile: false,
    id: 3,
    list_books: [
      { book_id: DUNE_ID, id: 31, position: 1 },
      { book_id: 101, id: 32, position: 2 },
    ],
    name: "Favourites",
    privacy_setting_id: 1,
    ranked: true,
    user_id: ME,
  }),
  me: () => [
    {
      activityPrivacySettingsId: 2,
      id: ME,
      librarian_roles: ["librarian"],
      membership: "supporter",
      name: "Reader",
      pro: true,
      username: "reader",
    },
  ],
  notification_deliveries: () => [{ id: 11, read: false }],
  notification_deliveries_aggregate: () => ({ aggregate: { count: 1 } }),
  pins: () => [{ id: 1, pinnable_id: 3, pinnable_type: "List", position: 0 }],
  reading_journals: () => [{ event: "note", id: 9 }],
  search: () => ({
    error: JSON_NULL,
    ids: [DUNE_ID],
    results: { found: 1, hits: [{ document: { author_names: ["Frank Herbert"], id: "100", title: "Dune" } }] },
  }),
  series: () => [{ id: 2, name: "Dune" }],
  series_by_pk: () => ({ id: 2, name: "Dune" }),
  update_goal: () => ({
    errors: JSON_NULL,
    goal: { description: "52 books", end_date: "2026-12-31", goal: 60, id: 4, metric: "book", progress: 0, start_date: "2026-01-01" },
    id: 4,
  }),
  update_list: () => ({ errors: JSON_NULL, id: 3, list: { id: 3 } }),
  update_list_books_many: () => [{ affectedRows: 2 }],
  update_notification_deliveries: () => ({ affectedRows: 1 }),
  update_reading_journal: () => ({ errors: JSON_NULL, id: 9, readingJournal: { id: 9 } }),
  update_user_book: (variables) => ({ error: JSON_NULL, id: 1, userBook: Struct.assign(entry, { hasReview: keepsReview(variables) }) }),
  update_user_book_read: () => ({ error: JSON_NULL, id: 5, userBookRead: read }),
  user_book_reads_by_pk: () => Struct.assign(read, { userBook: { bookId: DUNE_ID, id: 1, user_id: ME } }),
  user_books: () => [entry],
  user_books_aggregate: () => ({ aggregate: { count: 1 } }),
  user_books_by_pk: () => Struct.assign(entry, { user_book_reads: [read] }),
  user_settings: () => [{ contributor_role_lists: [] }],
  users: () => [{ id: 7, username: "friend" }],
  vibes: () => [{ id: 12, title: "Cozy" }],
}

/**
 * The fake answer for one root field.
 * @param {object} request The field and the request's variables.
 * @param {string} request.field The root field's name (not its alias).
 * @param {Readonly<Record<string, unknown>>} request.variables The request's variables.
 * @returns {unknown} The field's fixture, or a generic success payload.
 */
const fixture = (request: { readonly field: string; readonly variables: Readonly<Record<string, unknown>> }): unknown =>
  pipe(Rec.get(FIXTURES, request.field), Option.match({ onNone: () => GENERIC_PAYLOAD, onSome: (answer) => answer(request.variables) }))

export { JSON_NULL, ME, fixture }
