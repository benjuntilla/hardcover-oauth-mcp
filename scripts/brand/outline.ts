/**
 * The book's outline as a line drawing: its creased edges, lines across the pages, and the sparkles, less whatever
 * the book hides, found by casting rays toward the viewer.
 */
import { Array as Arr, Option, pipe } from "effect"
import { EdgesGeometry, Mesh, Raycaster, Vector3 } from "three"
import { FRONT, OBLIQUE_RIGHT, OBLIQUE_UP, PAGES, SOLIDS, SPARKLES, screen, sparkleOutline } from "#root/scripts/brand/book.ts"
import type { Point3, Polyline } from "#root/scripts/brand/book.ts"

type Segment = readonly [Point3, Point3]
type Chain = Arr.NonEmptyReadonlyArray<Point3>

const HALF = 0.5
const NEXT = 1
const ONE_BASED = 1

/** Faces that meet at a shallower angle than this are one smooth surface, with no edge drawn between them. */
const CREASE_DEGREES = 25
/** Hidden-line removal tests points this far apart along each edge, in drawing units, and at least both ends. */
const SAMPLE_STEP = 0.04
const MIN_SAMPLES = 2
/** Rays start this far in front of a point; a hit closer than that, less the tolerance, is something in the way. */
const RAY_START = 1000
const RAY_TOLERANCE = 1e-3
/** Endpoints within 0.001 units are the same point when joining segments into lines. */
const JOIN_DECIMALS = 3
const MIN_SEGMENT = 1e-6

/** A step that lands on the same spot on the page however deep it goes, so it points straight at the viewer. */
const DEPTH_STEP = 1
const TOWARD_VIEWER = new Vector3(-OBLIQUE_RIGHT, -OBLIQUE_UP, DEPTH_STEP).normalize()
const AWAY_FROM_VIEWER = TOWARD_VIEWER.clone().negate()
const raycaster = new Raycaster()
const meshes = pipe(
  SOLIDS,
  Arr.map((solid) => new Mesh(solid)),
)

const FEATURE_EDGES: ReadonlyArray<Segment> = pipe(
  SOLIDS,
  Arr.flatMap((solid) => {
    const position = new EdgesGeometry(solid, CREASE_DEGREES).getAttribute("position")
    const vertex = (index: number): Point3 => [position.getX(index), position.getY(index), position.getZ(index)]
    // Two vertices per edge, one after the other.
    return Arr.makeBy(position.count * HALF, (edge): Segment => [vertex(edge + edge), vertex(edge + edge + NEXT)])
  }),
)

const pageLines = (count: number): ReadonlyArray<Segment> =>
  Arr.makeBy(count, (index) => {
    const depth = PAGES.back + ((PAGES.front - PAGES.back) * (index + ONE_BASED)) / (count + ONE_BASED)
    return [
      [PAGES.left, PAGES.bottom, depth],
      [PAGES.right, PAGES.bottom, depth],
    ]
  })

const SPARKLE_EDGES: ReadonlyArray<Segment> = pipe(
  SPARKLES,
  Arr.flatMap((sparkle) => {
    const points = pipe(
      sparkleOutline(sparkle),
      Arr.map(([px, py]): Point3 => [px, py, FRONT]),
    )
    return Arr.zip(points, Arr.drop(points, NEXT))
  }),
)

const isVisible = (point: Point3): boolean => {
  raycaster.set(new Vector3(...point).addScaledVector(TOWARD_VIEWER, RAY_START), AWAY_FROM_VIEWER)
  return Option.match(Arr.head(raycaster.intersectObjects(meshes, false)), {
    onNone: () => true,
    onSome: (hit) => hit.distance >= RAY_START - RAY_TOLERANCE,
  })
}

const lerp = (segment: Segment, amount: number): Point3 => {
  const [[fromX, fromY, fromZ], [toX, toY, toZ]] = segment
  return [fromX + (toX - fromX) * amount, fromY + (toY - fromY) * amount, fromZ + (toZ - fromZ) * amount]
}

const length = ([from, to]: Segment): number => new Vector3(...from).distanceTo(new Vector3(...to))

// Runs of samples that are all visible or all hidden; each run's part of the edge reaches the next run's first sample.
const visibleParts = (segment: Segment): ReadonlyArray<Segment> => {
  const [, end] = segment
  const steps = Math.max(MIN_SAMPLES, Math.ceil(length(segment) / SAMPLE_STEP))
  const samples = pipe(
    Arr.makeBy(steps, (index) => lerp(segment, index / steps)),
    Arr.append(end),
    Arr.map((point) => ({ point, visible: isVisible(point) })),
  )
  const runStarts = pipe(
    Arr.groupWith(samples, (before, after) => before.visible === after.visible),
    Arr.map(Arr.headNonEmpty),
  )
  const runEnds = pipe(
    Arr.tailNonEmpty(runStarts),
    Arr.map(({ point }) => point),
    Arr.append(end),
  )
  return pipe(
    Arr.zip(runStarts, runEnds),
    Arr.filter(([start, stop]) => start.visible && start.point !== stop),
    Arr.map(([start, stop]): Segment => [start.point, stop]),
  )
}

const joinKey = (point: Point3): string =>
  pipe(
    point,
    Arr.map((coordinate) => coordinate.toFixed(JOIN_DECIMALS)),
    Arr.join(","),
  )

// The chain with the segment added at whichever end it touches, if it touches one.
const extend = (chain: Chain, [from, to]: Segment): Option.Option<Chain> => {
  const head = joinKey(Arr.headNonEmpty(chain))
  const tail = joinKey(Arr.lastNonEmpty(chain))
  if (joinKey(from) === tail) {
    return Option.some(Arr.append(chain, to))
  }
  if (joinKey(to) === tail) {
    return Option.some(Arr.append(chain, from))
  }
  if (joinKey(to) === head) {
    return Option.some(Arr.prepend(chain, from))
  }
  return joinKey(from) === head ? Option.some(Arr.prepend(chain, to)) : Option.none()
}

const firstExtension = (chain: Chain, pool: ReadonlyArray<Segment>): Option.Option<readonly [Chain, number]> =>
  Arr.findFirst(pool, (segment, index) => Option.map(extend(chain, segment), (longer) => [longer, index] as const))

const grow = (seed: Chain, pool: ReadonlyArray<Segment>): { readonly chain: Chain; readonly rest: ReadonlyArray<Segment> } => {
  let chain = seed
  let rest = pool
  let next = firstExtension(chain, rest)
  while (Option.isSome(next)) {
    const [longer, index] = next.value
    chain = longer
    rest = Arr.remove(rest, index)
    next = firstExtension(chain, rest)
  }
  return { chain, rest }
}

// Segments that share endpoints become one polyline, so their corners join instead of overlapping as two caps.
const join = (segments: ReadonlyArray<Segment>): ReadonlyArray<Chain> => {
  let pool: ReadonlyArray<Segment> = pipe(
    segments,
    Arr.filter((segment) => length(segment) > MIN_SEGMENT),
  )
  const chains: Array<Chain> = []
  while (Arr.isReadonlyArrayNonEmpty(pool)) {
    const grown = grow(Arr.lastNonEmpty(pool), Arr.initNonEmpty(pool))
    chains.push(grown.chain)
    pool = grown.rest
  }
  return chains
}

/**
 * The book's visible outline on the page.
 * @param {number} pageCount How many lines to draw across the bottom of the pages.
 * @returns {ReadonlyArray<Polyline>} The outline's polylines, in drawing units.
 */
const bookOutline = (pageCount: number): ReadonlyArray<Polyline> =>
  pipe(
    FEATURE_EDGES,
    Arr.appendAll(pageLines(pageCount)),
    Arr.appendAll(SPARKLE_EDGES),
    Arr.flatMap(visibleParts),
    join,
    Arr.map(Arr.map(screen)),
  )

export { bookOutline }
