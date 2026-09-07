import assert from 'node:assert/strict'
import { startDynamicDevRuntime } from '@pluxel/runtime-dynamic'

const entry = process.env.PLUXEL_TAKUMI_MARKDOWN_TYPST_DYNAMIC_ENTRY
assert.ok(entry, 'missing PLUXEL_TAKUMI_MARKDOWN_TYPST_DYNAMIC_ENTRY')

await using runtime = await startDynamicDevRuntime({ entry })
const rendered = await fetch(new URL('/__pluxel-test/typst/render', runtime.origin))
assert.equal(rendered.status, 200)
assert.equal(rendered.headers.get('content-type'), 'image/png')
assert.deepEqual(
	[...Buffer.from(await rendered.arrayBuffer()).subarray(0, 8)],
	[137, 80, 78, 71, 13, 10, 26, 10],
)

const unsafe = await fetch(new URL('/__pluxel-test/typst/error/unsafe', runtime.origin))
assert.equal(unsafe.status, 200)
assert.deepEqual(await unsafe.json(), { code: 'FORMULA_INVALID' })
