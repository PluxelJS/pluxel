import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { startDynamicDevRuntime } from '@pluxel/runtime-dynamic'

const entry = process.env.PLUXEL_PACKAGE_MANAGER_DYNAMIC_ENTRY
const managedRoot = process.env.PLUXEL_PACKAGE_MANAGER_MANAGED_ROOT
const expectedRunning = process.env.PLUXEL_PACKAGE_MANAGER_EXPECT_RUNNING
assert.ok(entry, 'missing dynamic entry')
assert.ok(managedRoot, 'missing managed root')
assert.ok(expectedRunning === '0' || expectedRunning === '1', 'missing expected running state')

await using runtime = await startDynamicDevRuntime({ entry })
const installPublished = runtime.ctx.commands.list().some(({ name }) => name === 'package.install')

assert.equal(installPublished, expectedRunning === '1')
assert.equal(existsSync(managedRoot), expectedRunning === '1')
assert.equal(existsSync(resolve(managedRoot, 'entries')), expectedRunning === '1')
