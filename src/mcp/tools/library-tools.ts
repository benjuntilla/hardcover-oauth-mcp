/**
 * Tools for the user's library (`user_books`) and reading sessions (`user_book_reads`).
 * They take book ids and find the user's row themselves, adding the book to the library
 * when a write needs it.
 */
import {
  DEFAULT_LIBRARY_PAGE,
  DEFAULT_REVIEW_PAGE,
  EntryResult,
  MAX_LIBRARY_PAGE,
  MAX_REVIEW_PAGE,
  OptionalAudio,
  OptionalClearableId,
  OptionalCount,
  OptionalDate,
  OptionalId,
  OptionalPercent,
  OptionalText,
  Rating,
  Sort,
} from "./library-params.ts"
import { Id, Json, JsonList, Limit, Offset, Privacy, Status } from "./common.ts"
import { Tool, Toolkit } from "effect/ai"
import { Schema } from "effect"
import { hardcoverTool } from "#src/mcp/define.ts"

const ListLibrary = hardcoverTool({
  description: "Books in the user's library, optionally by status, with rating, dates, and edition. Paged.",
  kind: "read",
  name: "hardcover_list_library",
  parameters: Schema.Struct({
    limit: Limit({ fallback: DEFAULT_LIBRARY_PAGE, max: MAX_LIBRARY_PAGE }),
    offset: Offset,
    sort: Schema.optionalKey(Sort),
    status: Schema.optionalKey(Status),
  }),
  scopes: ["read:library"],
  success: Schema.Struct({ books: JsonList, total: Schema.Int }),
  title: "List your library",
})

const CurrentlyReading = hardcoverTool({
  description: "Books the user is currently reading, with the open reading session's progress (pages, seconds, percent).",
  kind: "read",
  name: "hardcover_currently_reading",
  parameters: Tool.EmptyParams,
  scopes: ["read:library"],
  success: Schema.Struct({ books: JsonList }),
  title: "Currently reading",
})

const ListReviews = hardcoverTool({
  description: "The user's reviewed books, newest review first, with rating and review text.",
  kind: "read",
  name: "hardcover_list_reviews",
  parameters: Schema.Struct({ limit: Limit({ fallback: DEFAULT_REVIEW_PAGE, max: MAX_REVIEW_PAGE }), offset: Offset }),
  scopes: ["read:library"],
  success: Schema.Struct({ reviews: JsonList }),
  title: "List your reviews",
})

const GetEntry = hardcoverTool({
  description:
    "The user's library entry for a book: status, rating, review, private notes, dates, ownership, and every reading session " +
    "(read ids are needed to edit sessions). entry is null when the book isn't in the library.",
  kind: "read",
  name: "hardcover_get_library_entry",
  parameters: Schema.Struct({ bookId: Id("Book id.") }),
  scopes: ["read:library"],
  success: Schema.Struct({ entry: Json }),
  title: "Get your entry for a book",
})

const SetStatus = hardcoverTool({
  description:
    "Sets a book's status (want_to_read, currently_reading, read, paused, did_not_finish, ignored), adding it to the library if needed. " +
    "Doesn't change dates or progress; use hardcover_update_progress and hardcover_mark_finished for those.",
  kind: "update",
  name: "hardcover_set_status",
  parameters: Schema.Struct({
    bookId: Id("Book id."),
    editionId: OptionalId("Edition being read (optional)."),
    privacy: Schema.optionalKey(Privacy),
    status: Status,
  }),
  scopes: ["write:library", "read:library"],
  success: EntryResult,
  title: "Set reading status",
})

const RateBook = hardcoverTool({
  description:
    "Sets or clears (null) the user's star rating. Hardcover marks a rated book as Read, and adds a book not yet in the library as read.",
  kind: "update",
  name: "hardcover_rate_book",
  parameters: Schema.Struct({ bookId: Id("Book id."), rating: Schema.NullOr(Rating) }),
  scopes: ["write:library", "read:library"],
  success: EntryResult,
  title: "Rate a book",
})

const WriteReview = hardcoverTool({
  description:
    "Creates or replaces the user's review of a book (Markdown). A book not yet in the library is added as read; passing a rating also marks it Read.",
  destructive: true,
  kind: "update",
  name: "hardcover_write_review",
  parameters: Schema.Struct({
    bookId: Id("Book id."),
    hasSpoilers: Schema.optionalKey(Schema.Boolean),
    rating: Schema.optionalKey(Rating),
    review: Schema.NonEmptyString.annotate({ description: "Review text, Markdown." }),
    reviewedAt: OptionalDate("Review date, default today"),
  }),
  scopes: ["write:library", "write:reviews", "read:library"],
  success: EntryResult,
  title: "Write a review",
})

const DeleteReview = hardcoverTool({
  description: "Removes the user's review text from a book, keeping status and rating.",
  kind: "delete",
  name: "hardcover_delete_review",
  parameters: Schema.Struct({ bookId: Id("Book id.") }),
  scopes: ["write:library", "write:reviews", "read:library"],
  success: Schema.Struct({ entry: Json }),
  title: "Delete a review",
})

const UpdateEntry = hardcoverTool({
  description: "Changes other fields of a library entry: edition, privacy, private notes, recommended by/for, dates, read count.",
  kind: "update",
  name: "hardcover_update_library_entry",
  parameters: Schema.Struct({
    bookId: Id("Book id."),
    dateAdded: OptionalDate("Date added"),
    editionId: OptionalClearableId,
    firstStartedReadingDate: OptionalDate("First started reading"),
    lastReadDate: OptionalDate("Last finished"),
    privacy: Schema.optionalKey(Privacy),
    privateNotes: OptionalText,
    readCount: OptionalCount,
    recommendedBy: OptionalText,
    recommendedFor: OptionalText,
  }),
  scopes: ["write:library", "read:library"],
  success: Schema.Struct({ entry: Json }),
  title: "Edit your entry for a book",
})

const RemoveFromLibrary = hardcoverTool({
  description: "Deletes the user's library entry for a book, with its status, rating, review, and reading sessions.",
  kind: "delete",
  name: "hardcover_remove_from_library",
  parameters: Schema.Struct({ bookId: Id("Book id.") }),
  scopes: ["write:library", "read:library"],
  success: Schema.Struct({ removed: Schema.Boolean, userBookId: Schema.Int }),
  title: "Remove a book from your library",
})

const UpdateProgress = hardcoverTool({
  description:
    "Records progress on a book as a page, audio position in seconds, or percent. Marks it currently reading (adding it to the " +
    "library if needed) and updates the open reading session, starting one if there is none. Percent needs an edition with a " +
    "page count or audio length.",
  kind: "update",
  name: "hardcover_update_progress",
  parameters: Schema.Struct({
    bookId: Id("Book id."),
    editionId: OptionalId("Edition being read; defaults to the entry's edition."),
    page: OptionalCount,
    percent: OptionalPercent,
    seconds: OptionalAudio,
    startedAt: OptionalDate("Start date when a new session is started, default today"),
  }),
  scopes: ["write:library", "read:library"],
  success: Schema.Struct({ read: Json, status: Schema.String }),
  title: "Update reading progress",
})

const MarkFinished = hardcoverTool({
  description: "Finishes the open reading session (or records a finished one) on a date, sets the status to read, and optionally rates it.",
  kind: "update",
  name: "hardcover_mark_finished",
  parameters: Schema.Struct({
    bookId: Id("Book id."),
    finishedAt: OptionalDate("Finish date, default today"),
    rating: Schema.optionalKey(Rating),
  }),
  scopes: ["write:library", "read:library"],
  success: Schema.Struct({ entry: Json, read: Json }),
  title: "Mark a book finished",
})

const AddRead = hardcoverTool({
  description: "Records a reading of a book (a re-read or a past read) with start and/or finish dates. The book must be in the library.",
  kind: "create",
  name: "hardcover_add_read",
  parameters: Schema.Struct({
    bookId: Id("Book id."),
    editionId: OptionalId("Edition read."),
    finishedAt: OptionalDate("Finished"),
    startedAt: OptionalDate("Started"),
  }),
  scopes: ["write:library", "read:library"],
  success: Schema.Struct({ read: Json }),
  title: "Add a reading session",
})

const UpdateRead = hardcoverTool({
  description: "Changes a reading session's dates, progress, or edition. Get read ids from hardcover_get_library_entry.",
  kind: "update",
  name: "hardcover_update_read",
  parameters: Schema.Struct({
    editionId: OptionalId("Edition read."),
    finishedAt: OptionalDate("Finished"),
    page: OptionalCount,
    readId: Id("Reading session id."),
    seconds: OptionalCount,
    startedAt: OptionalDate("Started"),
  }),
  scopes: ["write:library", "read:library"],
  success: Schema.Struct({ read: Json }),
  title: "Edit a reading session",
})

const DeleteRead = hardcoverTool({
  description: "Deletes one reading session (dates and progress) from a book's history.",
  kind: "delete",
  name: "hardcover_delete_read",
  parameters: Schema.Struct({ readId: Id("Reading session id.") }),
  scopes: ["write:library", "read:library"],
  success: Schema.Struct({ deleted: Schema.Int }),
  title: "Delete a reading session",
})

const SetOwned = hardcoverTool({
  description:
    "Adds an edition to or removes it from the user's Owned list. As on Hardcover, owning an edition also shows in the user's activity unless the Owned list is private.",
  kind: "update",
  name: "hardcover_set_owned",
  parameters: Schema.Struct({ editionId: Id("Edition id."), owned: Schema.Boolean }),
  scopes: ["write:library", "read:lists", "write:lists"],
  success: Schema.Struct({ changed: Schema.Boolean, owned: Schema.Boolean }),
  title: "Mark an edition owned",
})

const LibraryToolkit = Toolkit.make(
  ListLibrary,
  CurrentlyReading,
  ListReviews,
  GetEntry,
  SetStatus,
  UpdateProgress,
  MarkFinished,
  RateBook,
  WriteReview,
  DeleteReview,
  UpdateEntry,
  SetOwned,
  RemoveFromLibrary,
  AddRead,
  UpdateRead,
  DeleteRead,
)

/**
 * Application module, not a public API.
 * @internal
 */
export {
  AddRead,
  DeleteRead,
  DeleteReview,
  GetEntry,
  ListLibrary,
  ListReviews,
  MarkFinished,
  RateBook,
  RemoveFromLibrary,
  SetOwned,
  SetStatus,
  UpdateEntry,
  UpdateProgress,
  UpdateRead,
  WriteReview,
  LibraryToolkit,
}
