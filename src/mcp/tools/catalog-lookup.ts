/** Id-or-slug lookups shared by the catalog tools. */
import type { ByPk, BySlug } from "#src/mcp/tools/catalog-operations.ts"
import { Effect, Option, Schema } from "effect"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { Session } from "#src/mcp/session.ts"
import { first } from "#src/mcp/tools/common.ts"

interface IdOrSlug {
  readonly id?: number
  readonly slug?: string
}

const BookSlug = Schema.Struct({ slug: Schema.String })

/**
 * The row, or not_found when the id matched nothing.
 * @param {unknown} row The decoded row, if Hardcover returned one.
 * @param {string} missing What a missing id refers to.
 * @returns {Effect.Effect<unknown, HardcoverError>} The row.
 */
const rowOrMissing = (row: unknown, missing: string): Effect.Effect<unknown, HardcoverError> =>
  Option.match(Option.fromNullishOr(row), {
    onNone: () => HardcoverError.make({ kind: "not_found", message: `No ${missing} with that id.` }),
    onSome: Effect.succeed,
  })

/**
 * Loads one row by id, or the first row matching a slug; one of them is required.
 * @param {object} options The two queries and what a missing row is called.
 * @param {Function} options.byId Runs the query selecting the row by id.
 * @param {Function} options.bySlug Runs the query selecting rows by slug.
 * @param {string} options.idField The by-id query's root field.
 * @param {string} options.missing What a missing id refers to.
 * @param {IdOrSlug} options.params The caller's id and slug.
 * @param {string} options.slugField The by-slug query's root field.
 * @param {string} options.what What a missing slug refers to.
 * @returns {Effect.Effect<unknown, HardcoverError, Session>} The row.
 */
const lookupByIdOrSlug = (
  options: Readonly<{
    byId: (id: number) => Effect.Effect<ByPk, HardcoverError, Session>
    bySlug: (slug: string) => Effect.Effect<BySlug, HardcoverError, Session>
    idField: "authors_by_pk" | "books_by_pk" | "series_by_pk"
    missing: string
    params: Readonly<IdOrSlug>
    slugField: "authors" | "books" | "series"
    what: string
  }>,
): Effect.Effect<unknown, HardcoverError, Session> =>
  Effect.gen(function* lookupRow() {
    const { byId, bySlug, idField, missing, params, slugField, what } = options
    const id = Option.fromNullishOr(params.id)
    if (Option.isSome(id)) {
      const data = yield* byId(id.value)
      return yield* rowOrMissing(data[idField], missing)
    }
    const data = yield* Option.match(Option.fromNullishOr(params.slug), {
      onNone: () => HardcoverError.make({ kind: "invalid", message: `Pass the ${what}'s id or slug.` }),
      onSome: bySlug,
    })
    return yield* first({ rows: data[slugField] ?? [], what: `${what} with that slug` })
  })

/**
 * The slug Hardcover uses in a book URL.
 * @param {unknown} book A decoded book row.
 * @returns {Effect.Effect<string>} The slug, or a defect when the row has none.
 */
const bookSlug = (book: unknown): Effect.Effect<string> =>
  Schema.decodeUnknownEffect(BookSlug)(book).pipe(
    Effect.map((row) => row.slug),
    Effect.catchTag("SchemaError", () => Effect.die("Hardcover returned a book without a slug")),
  )

/**
 * Application module, not a public API.
 * @internal
 */
export { bookSlug, lookupByIdOrSlug }
