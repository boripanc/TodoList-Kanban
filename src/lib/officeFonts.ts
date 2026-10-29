// Free fonts with the same letter widths as the Office fonts that specs use,
// so Word and Excel files keep their line and page breaks on devices without
// Office installed. A device that has the real font uses it (local() first).
// Loaded only when a file is opened.
import arimo400normal from '@fontsource/arimo/files/arimo-latin-400-normal.woff2?url'
import arimo400italic from '@fontsource/arimo/files/arimo-latin-400-italic.woff2?url'
import arimo700normal from '@fontsource/arimo/files/arimo-latin-700-normal.woff2?url'
import arimo700italic from '@fontsource/arimo/files/arimo-latin-700-italic.woff2?url'
import caladea400normal from '@fontsource/caladea/files/caladea-latin-400-normal.woff2?url'
import caladea400italic from '@fontsource/caladea/files/caladea-latin-400-italic.woff2?url'
import caladea700normal from '@fontsource/caladea/files/caladea-latin-700-normal.woff2?url'
import caladea700italic from '@fontsource/caladea/files/caladea-latin-700-italic.woff2?url'
import carlito400normal from '@fontsource/carlito/files/carlito-latin-400-normal.woff2?url'
import carlito400italic from '@fontsource/carlito/files/carlito-latin-400-italic.woff2?url'
import carlito700normal from '@fontsource/carlito/files/carlito-latin-700-normal.woff2?url'
import carlito700italic from '@fontsource/carlito/files/carlito-latin-700-italic.woff2?url'
import cousine400normal from '@fontsource/cousine/files/cousine-latin-400-normal.woff2?url'
import cousine400italic from '@fontsource/cousine/files/cousine-latin-400-italic.woff2?url'
import cousine700normal from '@fontsource/cousine/files/cousine-latin-700-normal.woff2?url'
import cousine700italic from '@fontsource/cousine/files/cousine-latin-700-italic.woff2?url'
import tinos400normal from '@fontsource/tinos/files/tinos-latin-400-normal.woff2?url'
import tinos400italic from '@fontsource/tinos/files/tinos-latin-400-italic.woff2?url'
import tinos700normal from '@fontsource/tinos/files/tinos-latin-700-normal.woff2?url'
import tinos700italic from '@fontsource/tinos/files/tinos-latin-700-italic.woff2?url'

const files: Record<string, Record<string, string>> = {
  arimo: { '400 normal': arimo400normal, '400 italic': arimo400italic, '700 normal': arimo700normal, '700 italic': arimo700italic },
  caladea: { '400 normal': caladea400normal, '400 italic': caladea400italic, '700 normal': caladea700normal, '700 italic': caladea700italic },
  carlito: { '400 normal': carlito400normal, '400 italic': carlito400italic, '700 normal': carlito700normal, '700 italic': carlito700italic },
  cousine: { '400 normal': cousine400normal, '400 italic': cousine400italic, '700 normal': cousine700normal, '700 italic': cousine700italic },
  tinos: { '400 normal': tinos400normal, '400 italic': tinos400italic, '700 normal': tinos700normal, '700 italic': tinos700italic },
}

/** Office font name → the free font with the same metrics. */
const standIns: Record<string, string> = {
  'Calibri': 'carlito',
  'Cambria': 'caladea',
  'Arial': 'arimo',
  'Helvetica': 'arimo',
  'Times New Roman': 'tinos',
  'Courier New': 'cousine',
}

let loaded = false

/** Make Calibri, Cambria, Arial, Times New Roman and Courier New available to the page. */
export function loadOfficeFonts() {
  if (loaded || typeof FontFace === 'undefined' || !document.fonts) return
  loaded = true
  for (const [family, pkg] of Object.entries(standIns)) {
    for (const [variant, url] of Object.entries(files[pkg])) {
      const [weight, style] = variant.split(' ')
      const face = new FontFace(family, `local("${family}"), url("${url}") format("woff2")`, { weight, style })
      document.fonts.add(face)
    }
  }
}
