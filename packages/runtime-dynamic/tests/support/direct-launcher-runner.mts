import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

import { startDynamicDevRuntime } from '../../src/index.ts'

const entry = process.env.PLUXEL_DYNAMIC_DIRECT_ENTRY
assert.ok(entry, 'missing PLUXEL_DYNAMIC_DIRECT_ENTRY')

const runtime = await startDynamicDevRuntime({ entry: pathToFileURL(entry) })
const origin = runtime.origin
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/)
assert.ok(runtime.ctx)

const response = await fetch(new URL('/__direct-launcher-ready-probe__', origin))
assert.ok(response instanceof Response)

await runtime.dispose()
await runtime[Symbol.asyncDispose]()
assert.throws(() => runtime.ctx, /is closed/i)
await assert.rejects(fetch(new URL('/__direct-launcher-closed-probe__', origin)))
