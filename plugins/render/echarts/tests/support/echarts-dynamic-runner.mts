import assert from 'node:assert/strict'
import { vitePreset } from '@pluxel/preset/vite'
import { createServer } from 'vite'

const entry = process.env.PLUXEL_ECHARTS_DYNAMIC_ENTRY
assert.ok(entry, 'missing PLUXEL_ECHARTS_DYNAMIC_ENTRY')

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
const rendered = await fetch(new URL('/__pluxel-test/echarts/render', runtime.origin))
assert.equal(rendered.status, 200)
assert.equal(rendered.headers.get('content-type'), 'image/png')
assert.deepEqual(
	[...Buffer.from(await rendered.arrayBuffer()).subarray(0, 8)],
	[137, 80, 78, 71, 13, 10, 26, 10],
)

await expectError('/__pluxel-test/echarts/error/remote-image', 'UNSUPPORTED_IMAGE_SOURCE')
await expectError('/__pluxel-test/echarts/error/formatter', 'WORKER_INPUT_UNSUPPORTED')

async function expectError(path: string, code: string): Promise<void> {
	const response = await fetch(new URL(path, runtime.origin))
	assert.equal(response.status, 200)
	assert.deepEqual(await response.json(), { code })
}
