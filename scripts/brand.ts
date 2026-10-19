/**
 * Draws the site's icons and the repository's social preview from the book model in scripts/brand:
 *   mise run brand
 */
import { Array as Arr, Effect, pipe } from "effect"
import { FONT_FILES, SOCIAL_WIDTH, socialPreview } from "#root/scripts/brand/social.ts"
import { decodeFonts, ico, png } from "#root/scripts/brand/raster.ts"
import { readText, writeBytes } from "#root/scripts/script-io.ts"
import type { Lettering } from "#root/scripts/brand/lettering.ts"
import { makeLettering } from "#root/scripts/brand/lettering.ts"
import { tile } from "#root/scripts/brand/drawing.ts"

interface Output {
  readonly bytes: Uint8Array
  readonly file: string
}

const HERSHEY_SANS = "hersheytext/svg_fonts/HersheySans1.svg"
const PIXELS = { appleTouch: 180, icon: 512, large: 48, medium: 32, small: 16 } as const
const NO_FONTS: ReadonlyArray<string> = []
const REPO_ROOT = new URL("../", import.meta.url)

const icons = (lettering: Lettering): ReadonlyArray<Output> => {
  const bold = tile({ grid: false, lettering, level: "bold" })
  const icon = tile({ grid: true, lettering, level: "icon" })
  const favicons = pipe(
    [PIXELS.small, PIXELS.medium, PIXELS.large],
    Arr.map((size) => ({ png: png({ fontFiles: NO_FONTS, svg: bold, width: size }), size })),
  )
  return [
    { bytes: new TextEncoder().encode(bold), file: "site/public/favicon.svg" },
    { bytes: ico(favicons), file: "site/public/favicon.ico" },
    { bytes: png({ fontFiles: NO_FONTS, svg: bold, width: PIXELS.large }), file: "site/public/icon-48.png" },
    { bytes: png({ fontFiles: NO_FONTS, svg: icon, width: PIXELS.icon }), file: "site/public/icon-512.png" },
    { bytes: png({ fontFiles: NO_FONTS, svg: icon, width: PIXELS.appleTouch }), file: "site/public/apple-touch-icon.png" },
  ]
}

const draw = Effect.gen(function* draw() {
  const hersheySans = yield* readText(new URL(import.meta.resolve(HERSHEY_SANS)))
  const lettering = makeLettering(hersheySans)
  const fontFiles = yield* decodeFonts(FONT_FILES)
  const social = { bytes: png({ fontFiles, svg: socialPreview(lettering), width: SOCIAL_WIDTH }), file: ".github/social-preview.png" }
  const outputs = Arr.append(icons(lettering), social)
  yield* pipe(
    outputs,
    Effect.forEach(({ bytes, file }) => writeBytes({ bytes, url: new URL(file, REPO_ROOT) })),
  )
  yield* Effect.logInfo(
    `Drew ${pipe(
      outputs,
      Arr.map(({ file }) => file),
      Arr.join(", "),
    )}`,
  )
})

if (import.meta.main) {
  Effect.runFork(draw)
}
