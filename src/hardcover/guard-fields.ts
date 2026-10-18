/** Root-field and argument-key collection for the GraphQL guard. */
import { Array as Arr, Predicate, Record as Rec, pipe } from "effect"
import type { DocumentNode, FragmentDefinitionNode, SelectionNode, SelectionSetNode } from "graphql"
import { Kind, visit } from "graphql"

interface Walk {
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>
  readonly seen: ReadonlySet<string>
}

const isField = (selection: SelectionNode): selection is Extract<SelectionNode, { readonly kind: typeof Kind.FIELD }> =>
  selection.kind === Kind.FIELD

const isInlineFragment = (selection: SelectionNode): selection is Extract<SelectionNode, { readonly kind: typeof Kind.INLINE_FRAGMENT }> =>
  selection.kind === Kind.INLINE_FRAGMENT

const isSpread = (selection: SelectionNode): selection is Extract<SelectionNode, { readonly kind: typeof Kind.FRAGMENT_SPREAD }> =>
  selection.kind === Kind.FRAGMENT_SPREAD

const walkFields = (selectionSet: SelectionSetNode, walk: Walk): ReadonlyArray<string> =>
  pipe(
    selectionSet.selections,
    Arr.flatMap((selection): ReadonlyArray<string> => {
      if (isField(selection)) {
        return [selection.name.value]
      }
      if (isInlineFragment(selection)) {
        return walkFields(selection.selectionSet, walk)
      }
      if (!isSpread(selection) || walk.seen.has(selection.name.value)) {
        return []
      }
      const fragment = walk.fragments.get(selection.name.value)
      if (Predicate.isUndefined(fragment)) {
        return []
      }
      return walkFields(fragment.selectionSet, { fragments: walk.fragments, seen: new Set([...walk.seen, selection.name.value]) })
    }),
  )

const rootFieldsOf = (selectionSet: SelectionSetNode, fragments: ReadonlyMap<string, FragmentDefinitionNode>): ReadonlyArray<string> =>
  walkFields(selectionSet, { fragments, seen: new Set<string>() })

const keysOf = (value: unknown): ReadonlyArray<string> => {
  if (Arr.isArray(value)) {
    return pipe(value, Arr.flatMap(keysOf))
  }
  if (Predicate.isNull(value) || !Predicate.isObject(value)) {
    return []
  }
  return pipe(
    Rec.toEntries(value),
    Arr.flatMap((entry) => {
      const [key, nested] = entry
      return Arr.prepend(keysOf(nested), key)
    }),
  )
}

const collectKeys = (input: { readonly keys: ReadonlySet<string>; readonly value: unknown }): Set<string> =>
  new Set([...input.keys, ...keysOf(input.value)])

interface FieldWalk {
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>
  readonly operation: { readonly selectionSet: SelectionSetNode }
}

const publicRootFields = (input: FieldWalk): ReadonlyArray<string> =>
  pipe(
    rootFieldsOf(input.operation.selectionSet, input.fragments),
    Arr.filter((name) => !name.startsWith("__")),
  )

interface CollectedNames {
  readonly selected: ReadonlySet<string>
  readonly usedKeys: ReadonlySet<string>
}

const visitNames = (document: DocumentNode): CollectedNames => {
  const usedKeys = new Set<string>()
  const selected = new Set<string>()
  visit(document, {
    Argument(node) {
      usedKeys.add(node.name.value)
    },
    Field(node) {
      selected.add(node.name.value)
    },
    ObjectField(node) {
      usedKeys.add(node.name.value)
    },
  })
  return { selected, usedKeys }
}

export { collectKeys, publicRootFields, visitNames }
