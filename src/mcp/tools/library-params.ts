/** Parameter and result schemas shared by the library tools. */
import { DateString, Id, Json } from "./common.ts"
import { Schema } from "effect"

const MAX_LIBRARY_PAGE = 100
const MAX_REVIEW_PAGE = 50
const DEFAULT_LIBRARY_PAGE = 25
const DEFAULT_REVIEW_PAGE = 10
const MIN_RATING = 0.5
const MAX_RATING = 5
const RATING_STEP = 0.5
const MIN_COUNT = 0
const MIN_PERCENT = 0
const MAX_PERCENT = 100

const Rating = Schema.Finite.check(
  Schema.isMultipleOf(RATING_STEP),
  Schema.isBetween({ maximum: MAX_RATING, minimum: MIN_RATING }),
).annotate({
  description: "0.5 to 5 in half-star steps.",
})

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_COUNT))
const OptionalCount = Schema.optionalKey(NonNegativeInt)
const OptionalId = (description: string): Schema.optionalKey<Schema.Int> => Schema.optionalKey(Id(description))
const OptionalDate = (description: string): Schema.optionalKey<Schema.String> => Schema.optionalKey(DateString(description))
const ClearableId = Schema.NullOr(Id("Edition id, or null for none."))
const OptionalClearableId = Schema.optionalKey(ClearableId)
const OptionalText = Schema.optionalKey(Schema.NullOr(Schema.String))
const Percent = Schema.Finite.check(Schema.isBetween({ maximum: MAX_PERCENT, minimum: MIN_PERCENT }))
const OptionalPercent = Schema.optionalKey(Percent)
const AudioPosition = NonNegativeInt.annotate({ description: "Audiobook position." })
const OptionalAudio = Schema.optionalKey(AudioPosition)

const Sort = Schema.Literals(["updated", "added", "last_read", "rating", "title"]).annotate({ description: "Default updated." })

const EntryResult = Schema.Struct({ added: Schema.Boolean, entry: Json })

/**
 * Application module, not a public API.
 * @internal
 */
export {
  MAX_LIBRARY_PAGE,
  MAX_REVIEW_PAGE,
  DEFAULT_LIBRARY_PAGE,
  DEFAULT_REVIEW_PAGE,
  Rating,
  OptionalCount,
  OptionalId,
  OptionalDate,
  OptionalClearableId,
  OptionalText,
  OptionalPercent,
  OptionalAudio,
  Sort,
  EntryResult,
}
