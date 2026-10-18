/** The GraphQL operations behind the reading-journal tools. */
import { JsonList, Payload, run } from "#src/mcp/tools/common.ts"
import { GraphQL } from "effect/graphql"
import { Schema } from "effect"

const ENTRY_FIELDS = "id event entry action_at privacy_setting_id metadata book_id edition_id"
const LISTED_FIELDS = `${ENTRY_FIELDS} book { id title slug } taggings { spoiler tag { tag tag_category { category } } }`

const AccountPrivacy = Schema.Struct({
  me: Schema.Array(Schema.Struct({ activity_privacy_settings_id: Schema.Finite })),
})

const JournalRows = Schema.Struct({ reading_journals: JsonList })

const InsertedJournal = Schema.Struct({
  insert_reading_journal: Payload({ reading_journal: Schema.Unknown }),
})

const UpdatedJournal = Schema.Struct({
  update_reading_journal: Payload({ reading_journal: Schema.Unknown }),
})

const DeletedJournal = Schema.Struct({
  delete_reading_journal: Payload({ id: Schema.Int }),
})

/** `BasicTag`: a journal entry's tag. */
const BasicTag = Schema.Struct({ category: Schema.String, spoiler: Schema.Boolean, tag: Schema.String })

/** `ReadingJournalCreateType`, with the fields the tool sets. */
const JournalCreateInput = Schema.Struct({
  action_at: Schema.String,
  book_id: Schema.Int,
  edition_id: Schema.optional(Schema.Int),
  entry: Schema.String,
  event: Schema.String,
  privacy_setting_id: Schema.Int,
  tags: Schema.Array(BasicTag),
})

/** `ReadingJournalUpdateType`, with the fields the tool may change; omitted ones are left as they are. */
const JournalUpdateInput = Schema.Struct({
  action_at: Schema.optional(Schema.String),
  entry: Schema.optional(Schema.String),
  event: Schema.optional(Schema.String),
  privacy_setting_id: Schema.optional(Schema.Int),
})

const defaultPrivacy = run(
  GraphQL.query("DefaultPrivacy", {
    document: `query DefaultPrivacy { me { activity_privacy_settings_id } }`,
    result: AccountPrivacy,
  }),
)

const journalOf = run(
  GraphQL.query("Journal", {
    document: `query Journal($userId: Int!, $limit: Int!, $offset: Int!) {
      reading_journals(where: {user_id: {_eq: $userId}}, order_by: [{action_at: desc}, {id: desc}], limit: $limit, offset: $offset) {
        ${LISTED_FIELDS}
      }
    }`,
    result: JournalRows,
    variables: { limit: Schema.Int, offset: Schema.Int, userId: Schema.Int },
  }),
)

const bookJournalOf = run(
  GraphQL.query("Journal", {
    document: `query Journal($userId: Int!, $bookId: Int!, $limit: Int!, $offset: Int!) {
      reading_journals(
        where: {user_id: {_eq: $userId}, book_id: {_eq: $bookId}}, order_by: [{action_at: desc}, {id: desc}], limit: $limit, offset: $offset
      ) {
        ${LISTED_FIELDS}
      }
    }`,
    result: JournalRows,
    variables: { bookId: Schema.Int, limit: Schema.Int, offset: Schema.Int, userId: Schema.Int },
  }),
)

const insertJournal = run(
  GraphQL.mutation("AddJournal", {
    document: `mutation AddJournal($object: ReadingJournalCreateType!) {
      insert_reading_journal(object: $object) { id errors reading_journal { ${ENTRY_FIELDS} } }
    }`,
    result: InsertedJournal,
    variables: { object: JournalCreateInput },
  }),
)

const updateJournal = run(
  GraphQL.mutation("UpdateJournal", {
    document: `mutation UpdateJournal($id: Int!, $object: ReadingJournalUpdateType!) {
      update_reading_journal(id: $id, object: $object) { id errors reading_journal { ${ENTRY_FIELDS} } }
    }`,
    result: UpdatedJournal,
    variables: { id: Schema.Int, object: JournalUpdateInput },
  }),
)

const removeJournal = run(
  GraphQL.mutation("DeleteJournal", {
    document: `mutation DeleteJournal($id: Int!) { delete_reading_journal(id: $id) { id } }`,
    result: DeletedJournal,
    variables: { id: Schema.Int },
  }),
)

type JournalTag = typeof BasicTag.Type

/**
 * Application module, not a public API.
 * @internal
 */
export { bookJournalOf, defaultPrivacy, insertJournal, journalOf, removeJournal, updateJournal }
/**
 * Application module, not a public API.
 * @internal
 */
export type { JournalTag }
