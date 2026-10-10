import assert from 'node:assert/strict'
import { vitePreset } from '@pluxel/services/vite'
import { createServer } from 'vite'

const entry = process.env.PLUXEL_TYPST_DYNAMIC_ENTRY
assert.ok(entry, 'missing PLUXEL_TYPST_DYNAMIC_ENTRY')
const server = await createServer({
	configFile: false,
	plugins: [vitePreset({ entry })],
	server: { host: '127.0.0.1', port: 0 },
	logLevel: 'silent',
})
await server.listen()
await using runtime = {
	origin: server.resolvedUrls!.local[0]!,
	[Symbol.asyncDispose]: () => server.close(),
}
const rendered = await fetch(new URL('/__pluxel-test/typst/document', runtime.origin))
assert.equal(rendered.status, 200, await rendered.clone().text())
assert.equal(rendered.headers.get('content-type'), 'application/pdf')
assert.equal(
	Buffer.from(await rendered.arrayBuffer())
		.subarray(0, 5)
		.toString(),
	'%PDF-',
)
