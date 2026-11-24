import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = dirname(fileURLToPath(import.meta.url))
if (!process.argv[2]) throw new Error('Usage: node build-copilot.mjs <output-directory>')
const outdir = resolve(process.argv[2])
mkdirSync(outdir, { recursive: true })
for (const [entry, output] of [
  ['bridge.mjs', 'bridge.mjs'],
  ['copilot-extension.mjs', 'extension.mjs'],
]) {
  await build({
    entryPoints: [join(source, entry)],
    outfile: join(outdir, output),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@github/copilot-sdk/extension'],
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    legalComments: 'eof',
  })
}
console.log(`Built Copilot Intercom adapter at ${outdir}`)
