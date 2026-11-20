import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { vitePreset } from '@pluxel/services/vite'
import { createServer } from 'vite'

const entry = fileURLToPath(new URL('./application.ts', import.meta.url))
const server = await createServer({
	configFile: false,
	plugins: [vitePreset({ entry })],
	server: { host: '127.0.0.1', port: 0 },
	logLevel: 'silent',
})
await using _serverCleanup = { [Symbol.asyncDispose]: () => server.close() }
await server.listen()
const origin = server.resolvedUrls!.local[0]!
const rendered = await fetch(new URL('/__pluxel-test/typst/document', origin))
assert.equal(rendered.status, 200, `Session PDF: ${await rendered.clone().text()}`)
assert.equal(rendered.headers.get('content-type'), 'application/pdf')
assert.equal(
	Buffer.from(await rendered.arrayBuffer())
		.subarray(0, 5)
		.toString(),
	'%PDF-',
)
const svg = await fetch(new URL('/__pluxel-test/typst/svg', origin))
assert.equal(svg.status, 200, `Stateless SVG: ${await svg.clone().text()}`)
assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
assert.match(await svg.text(), /^<svg/)
console.log('Verified Typst PDF and SVG')
