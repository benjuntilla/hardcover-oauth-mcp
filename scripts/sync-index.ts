/** Turns Hardcover's SDL and capability documents into the compact API index. */
import { Array as Arr, Option, Predicate, Record as Rec, String as Str, Struct, pipe } from "effect"
import type { GraphQLField, GraphQLInputField, GraphQLNamedType, GraphQLSchema } from "graphql"
import { isEnumType, isInputObjectType, isInterfaceType, isObjectType, isScalarType, isUnionType } from "graphql"

const EMPTY_ARGS = 0
const ORDER_BY = "order_by"
const ROOT_QUERY = "query_root"
const ROOT_MUTATION = "mutation_root"
const ROOT_SUBSCRIPTION = "subscription_root"
const INTROSPECTION_PREFIX = "__"
const WHITESPACE = /\s+/gv

interface TypeShape {
  readonly fields?: ReadonlyArray<string>
  readonly kind: string
  readonly types?: ReadonlyArray<string>
  readonly values?: ReadonlyArray<string>
}

interface OperationEntry {
  readonly args: string
  readonly description?: string
  readonly kind: "query" | "mutation"
  readonly returns: string
  readonly scopes: ReadonlyArray<string>
}

interface ScopeSides {
  readonly read: ReadonlyArray<string>
  readonly write: ReadonlyArray<string>
}

const oneLine = (text: string | null | undefined): Option.Option<string> => {
  const trimmed = pipe(text ?? "", Str.replaceAll(WHITESPACE, " "), Str.trim)
  return Str.isNonEmpty(trimmed) ? Option.some(trimmed) : Option.none()
}

const argumentList = (field: GraphQLField<unknown, unknown>): string =>
  pipe(
    field.args,
    Arr.map((arg) => `${arg.name}: ${String(arg.type)}`),
    Arr.join(", "),
  )

const fieldLine = (field: GraphQLField<unknown, unknown> | GraphQLInputField): string => {
  if ("args" in field && field.args.length > EMPTY_ARGS) {
    return `${field.name}(${argumentList(field)}): ${String(field.type)}`
  }
  return String(field.type) === ORDER_BY ? field.name : `${field.name}: ${String(field.type)}`
}

const linesOf = (fields: Readonly<Record<string, GraphQLField<unknown, unknown> | GraphQLInputField>>): ReadonlyArray<string> =>
  pipe(fields, Rec.values, Arr.map(fieldLine))

const shapeOf = (type: GraphQLNamedType): Option.Option<TypeShape> => {
  if (isObjectType(type) || isInterfaceType(type)) {
    return Option.some({ fields: linesOf(type.getFields()), kind: "object" })
  }
  if (isInputObjectType(type)) {
    return Option.some({ fields: linesOf(type.getFields()), kind: "input" })
  }
  if (isEnumType(type)) {
    return Option.some({
      kind: "enum",
      values: pipe(
        type.getValues(),
        Arr.map((value) => value.name),
      ),
    })
  }
  if (isUnionType(type)) {
    return Option.some({
      kind: "union",
      types: pipe(
        type.getTypes(),
        Arr.map((member) => member.name),
      ),
    })
  }
  return isScalarType(type) ? Option.some({ kind: "scalar" }) : Option.none()
}

const isRootType = (name: string): boolean =>
  name === ROOT_QUERY || name === ROOT_MUTATION || name === ROOT_SUBSCRIPTION || name.startsWith(INTROSPECTION_PREFIX)

const withDescription = (shape: TypeShape, description: string | null | undefined): TypeShape & { readonly description?: string } =>
  pipe(oneLine(description), Option.match({ onNone: () => shape, onSome: (text) => Struct.assign(shape, { description: text }) }))

const describedType = (type: GraphQLNamedType): Option.Option<TypeShape & { readonly description?: string }> =>
  isRootType(type.name)
    ? Option.none()
    : pipe(
        shapeOf(type),
        Option.map((shape) => withDescription(shape, type.description)),
      )

const sidesFor = (kind: "query" | "mutation", sides: ScopeSides | undefined): ReadonlyArray<string> => {
  if (Predicate.isUndefined(sides)) {
    return []
  }
  return kind === "query" ? sides.read : sides.write
}

const operationEntry = (kind: "query" | "mutation", field: GraphQLField<unknown, unknown>, sides: ScopeSides | undefined): OperationEntry =>
  pipe(
    oneLine(field.description),
    Option.match({
      onNone: () => ({ args: argumentList(field), kind, returns: String(field.type), scopes: sidesFor(kind, sides) }),
      onSome: (description) => ({
        args: argumentList(field),
        description,
        kind,
        returns: String(field.type),
        scopes: sidesFor(kind, sides),
      }),
    }),
  )

const fieldsOf = (schema: GraphQLSchema, kind: "query" | "mutation"): ReadonlyArray<GraphQLField<unknown, unknown>> => {
  const root = kind === "query" ? schema.getQueryType() : schema.getMutationType()
  if (Predicate.isUndefined(root) || Predicate.isNull(root)) {
    return []
  }
  return pipe(root.getFields(), Rec.values)
}

interface OperationIndexInput {
  readonly allowed: ReadonlySet<string>
  readonly operationScopes: Readonly<Record<string, ScopeSides>>
  readonly schema: GraphQLSchema
}

const indexOperations = (input: OperationIndexInput): Readonly<Record<string, OperationEntry>> => {
  const { allowed, operationScopes, schema } = input
  const entries = pipe(
    ["query", "mutation"] as const,
    Arr.flatMap((kind) =>
      pipe(
        fieldsOf(schema, kind),
        Arr.map((field) =>
          allowed.has(field.name)
            ? Option.some([field.name, operationEntry(kind, field, operationScopes[field.name])] as const)
            : Option.none(),
        ),
        Arr.getSomes,
      ),
    ),
  )
  return Rec.fromEntries(entries)
}

const indexTypes = (schema: GraphQLSchema): Readonly<Record<string, TypeShape & { readonly description?: string }>> => {
  const entries = pipe(
    schema.getTypeMap(),
    Rec.values,
    Arr.map((type) =>
      pipe(
        describedType(type),
        Option.map((described) => [type.name, described] as const),
      ),
    ),
    Arr.getSomes,
  )
  return Rec.fromEntries(entries)
}

export type { OperationEntry, ScopeSides, TypeShape }
export { indexOperations, indexTypes }
