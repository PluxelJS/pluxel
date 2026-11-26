// Bundle the lowered plugin and its JS dependencies. Both Core entry points belong to the host.
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { build } from 'esbuild'

const { outputFiles } = await build({
	stdin: {
		contents: `import { DeviceLanguage, DeviceLocales } from './dist/index.js'
module.exports = { DeviceLanguage, DeviceLocales }`,
		resolveDir: process.cwd(),
		sourcefile: 'device-language.cjs',
	},
	bundle: true,
	format: 'cjs',
	platform: 'neutral',
	target: 'es2017',
	external: ['@pluxel/core', '@pluxel/core/toolchain'],
	write: false,
})
const code = outputFiles[0].text
const sha256 = createHash('sha256').update(code).digest('hex')
await writeFile('dist/device-language.pluxel.json', JSON.stringify({ format: 1, sha256, code }))
console.log(`dist/device-language.pluxel.json  sha256(code)=${sha256}`)
