/** The repository's social preview: the full drawing beside the pitch, on drafting paper. */
import { Array as Arr, pipe } from "effect"
import { SIZE, drawing } from "#root/scripts/brand/drawing.ts"
import type { Lettering } from "#root/scripts/brand/lettering.ts"

interface Font {
  readonly family: string
  readonly letterSpacing: number
  readonly size: number
  readonly weight: number
}

interface Line {
  readonly baseline: number
  readonly fill: string
  readonly font: Font
  readonly text: string
}

const WIDTH = 1280
const HEIGHT = 640
const INK = "#1a1a1a"
const MUTED = "#6b6864"
const PAPER = "#fff"
const HALF = 0.5
const NEXT = 1

/** Fine and coarse grid lines, one pixel wide at the start of each cell. */
const GRIDS = [
  { opacity: 0.045, step: 16 },
  { opacity: 0.09, step: 80 },
] as const
const FRAME = { inset: 24, radius: 16, stroke: 1.5 } as const
const TICK = { length: 8, spacing: 160, stroke: 1 } as const
const DRAWING = { left: 40, size: 540, top: 50 } as const

const HEADLINE: Font = { family: "Charter", letterSpacing: -0.56, size: 56, weight: 700 }
const BODY: Font = { family: "Charter", letterSpacing: 0, size: 25, weight: 400 }
const ADDRESS: Font = { family: "IBM Plex Mono", letterSpacing: 0, size: 22, weight: 500 }

/** The pitch, left-aligned, with its block centered in the frame. */
const COPY_LEFT = 610
const LINES: ReadonlyArray<Line> = [
  { baseline: 249.81, fill: INK, font: HEADLINE, text: "Your Hardcover library," },
  { baseline: 309.17, fill: INK, font: HEADLINE, text: "in Claude and ChatGPT." },
  { baseline: 359.36, fill: MUTED, font: BODY, text: "A remote MCP server with Hardcover sign-in." },
  { baseline: 392.36, fill: MUTED, font: BODY, text: "Use the hosted server or deploy your own." },
  { baseline: 448.36, fill: INK, font: ADDRESS, text: "hardcover.benjuntilla.com" },
]

/** The fonts the preview's text uses, as WOFF2 files in their npm packages. */
const FONT_FILES: ReadonlyArray<string> = [
  "charter-webfont/fonts/charter_regular.woff2",
  "charter-webfont/fonts/charter_bold.woff2",
  "@ibm/plex-mono/fonts/complete/woff2/IBMPlexMono-Medium.woff2",
]

const grid = ({ opacity, step }: (typeof GRIDS)[number]): string => {
  const columns = pipe(
    Arr.makeBy(WIDTH / step, (index) => `M${index * step + HALF} 0V${HEIGHT}`),
    Arr.join(""),
  )
  const rows = pipe(
    Arr.makeBy(HEIGHT / step, (index) => `M0 ${index * step + HALF}H${WIDTH}`),
    Arr.join(""),
  )
  return `<path d="${columns}${rows}" stroke="${INK}" stroke-opacity="${opacity}"/>`
}

// A rounded border inset from the edges, with ticks along it like a drawing sheet's zone marks.
const frame = (): string => {
  const edge = FRAME.inset + FRAME.stroke * HALF
  const border = `<rect x="${edge}" y="${edge}" width="${WIDTH - edge - edge}" height="${HEIGHT - edge - edge}" rx="${FRAME.radius - FRAME.stroke * HALF}" fill="none" stroke="${INK}" stroke-width="${FRAME.stroke}"/>`
  const tick = (box: { readonly height: number; readonly left: number; readonly top: number; readonly width: number }): string =>
    `<rect x="${box.left}" y="${box.top}" width="${box.width}" height="${box.height}" fill="${INK}"/>`
  const across = pipe(
    Arr.makeBy(WIDTH / TICK.spacing - NEXT, (index) => (index + NEXT) * TICK.spacing),
    Arr.flatMap((at) => [
      tick({ height: TICK.length, left: at, top: FRAME.inset, width: TICK.stroke }),
      tick({ height: TICK.length, left: at, top: HEIGHT - FRAME.inset - TICK.length, width: TICK.stroke }),
    ]),
  )
  const down = pipe(
    Arr.makeBy(HEIGHT / TICK.spacing - NEXT, (index) => (index + NEXT) * TICK.spacing),
    Arr.flatMap((at) => [
      tick({ height: TICK.stroke, left: FRAME.inset, top: at, width: TICK.length }),
      tick({ height: TICK.stroke, left: WIDTH - FRAME.inset - TICK.length, top: at, width: TICK.length }),
    ]),
  )
  return pipe([border], Arr.appendAll(across), Arr.appendAll(down), Arr.join(""))
}

const text = ({ baseline, fill, font, text: content }: Line): string =>
  `<text x="${COPY_LEFT}" y="${baseline}" font-family="${font.family}" font-size="${font.size}" font-weight="${font.weight}" letter-spacing="${font.letterSpacing}" fill="${fill}">${content}</text>`

/**
 * The social preview as an SVG document, which needs the fonts in `FONT_FILES` to render.
 * @param {Lettering} lettering The drawing labels' lettering.
 * @returns {string} The SVG document.
 */
const socialPreview = (lettering: Lettering): string => {
  const mark = `<svg x="${DRAWING.left}" y="${DRAWING.top}" width="${DRAWING.size}" height="${DRAWING.size}" viewBox="0 0 ${SIZE} ${SIZE}">${drawing({ lettering, level: "full" })}</svg>`
  const copy = pipe(LINES, Arr.map(text), Arr.join(""))
  const body = pipe(GRIDS, Arr.map(grid), Arr.append(frame()), Arr.append(mark), Arr.append(copy), Arr.join(""))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>${body}</svg>\n`
}

export { FONT_FILES, WIDTH as SOCIAL_WIDTH, socialPreview }
