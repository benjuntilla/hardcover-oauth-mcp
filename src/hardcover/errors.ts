import { Schema } from "effect"

/**
 * Every way a Hardcover call can fail, as one tool-facing error. MCP clients
 * show `message` to the model, so it says what happened and what to do next.
 */
class HardcoverError extends Schema.TaggedError<HardcoverError, { readonly brand: unique symbol }>()("HardcoverError", {
  kind: Schema.Literals([
    /** The Hardcover connection is gone; the user must reconnect the MCP server. */
    "reauth",
    /** Missing OAuth scope, librarian role, or Supporter membership. */
    "forbidden",
    /** The request itself is wrong (bad GraphQL, unknown field, invalid input). */
    "invalid",
    "not_found",
    "rate_limited",
    "timeout",
    "unavailable",
  ]),
  message: Schema.String,
  retryAfterSeconds: Schema.optionalKey(Schema.Finite),
}) {}

export { HardcoverError }
