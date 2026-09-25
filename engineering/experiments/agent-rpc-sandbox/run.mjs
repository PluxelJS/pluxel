import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { executeSandboxedRun, verifyBackend } from './executor.mjs'

const execFile = promisify(execFileCallback)
const here = dirname(fileURLToPath(import.meta.url))
const image = process.env.RPC_SANDBOX_IMAGE
const selected = process.argv[2] ?? 'all'
const cases = [
	'isolation',
	'rpc-await',
	'timeout',
	'memory',
	'kill-rpc',
	'disconnect',
	'file-escape',
	'rpc-limit',
	'rpc-concurrent',
]
if (selected !== 'all' && !cases.includes(selected))
	throw new Error(`Choose all or one of: ${cases.join(', ')}`)

async function compileProgram(name) {
	const sourceName =
		{ 'kill-rpc': 'rpc-await', timeout: 'infinite', disconnect: 'rpc-disconnect' }[name] ?? name
	const source = join(here, 'programs', `${sourceName}.ts`)
	const outputDir = await mkdtemp(join(tmpdir(), 'pluxel-rpc-ts-'))
	try {
		await execFile(
			join(here, '../../../node_modules/.bin/tsc'),
			[
				'--ignoreConfig',
				source,
				'--target',
				'es2022',
				'--module',
				'commonjs',
				'--strict',
				'--skipLibCheck',
				'--outDir',
				outputDir,
				'--pretty',
				'false',
			],
			{ maxBuffer: 1024 * 1024 },
		)
		return await readFile(join(outputDir, `${sourceName}.js`), 'utf8')
	} finally {
		await rm(outputDir, { recursive: true, force: true })
	}
}

async function toyInvoke(input) {
	if (
		typeof input?.text !== 'string' ||
		!Number.isInteger(input?.delayMs) ||
		input.delayMs < 0 ||
		input.delayMs > 1000
	)
		throw new Error('Invalid toy RPC input')
	await new Promise((resolve) => setTimeout(resolve, input.delayMs))
	return { echoed: input.text }
}

async function runCase(name) {
	const code = await compileProgram(name)
	const budgets = { wallMs: name === 'timeout' ? 300 : name === 'memory' ? 3000 : 2500 }
	const onStarted =
		name === 'kill-rpc'
			? async ({ firstAdmission, stop }) => {
					await Promise.race([
						firstAdmission,
						new Promise((_, reject) =>
							setTimeout(() => reject(new Error('RPC admission did not arrive')), 1500),
						),
					])
					await new Promise((resolve) => setTimeout(resolve, 50))
					await stop()
				}
			: undefined
	const report = await executeSandboxedRun({ code, image, budgets, onInvoke: toyInvoke, onStarted })
	const { exitCode, killReason, result, logs } = report
	if (name === 'isolation') {
		assert.equal(exitCode, 0, logs)
		assert.deepEqual(
			result && {
				hostFileVisible: result.hostFileVisible,
				mountedCanaryVisible: result.mountedCanaryVisible,
				hostProcessVisible: result.hostProcessVisible,
				networkReachable: result.networkReachable,
				memoryMax: result.memoryMax,
				pidsMax: result.pidsMax,
			},
			{
				hostFileVisible: false,
				mountedCanaryVisible: false,
				hostProcessVisible: false,
				networkReachable: false,
				memoryMax: '67108864',
				pidsMax: '16',
			},
		)
	} else if (name === 'rpc-await') {
		assert.equal(exitCode, 0, logs)
		assert.deepEqual(result, { echoed: 'hello' })
		assert.equal(report.admitted, 1)
	} else if (name === 'memory') {
		assert.equal(exitCode, 137, logs)
		assert.equal(killReason, null, 'memory must be enforced by cgroup, not wall timer')
	} else if (name === 'timeout') {
		assert.equal(exitCode, 137, logs)
		assert.equal(killReason, 'wall-time')
	} else if (name === 'kill-rpc' || name === 'disconnect') {
		assert.equal(exitCode, name === 'kill-rpc' ? 137 : 0, logs)
		assert.equal(report.activeAtExit, 1, 'server work must remain admitted after sandbox stop')
		assert.equal(report.settled, 1)
		assert.ok(report.drainMs >= 100, `drain returned too early: ${report.drainMs} ms`)
	} else if (name === 'file-escape') {
		assert.equal(exitCode, 0, logs)
		assert.deepEqual(result, ['EROFS', 'EROFS'])
	} else if (name === 'rpc-limit') {
		assert.equal(exitCode, 0, logs)
		assert.deepEqual(result, ['0', '1', '2', '3', 'RPC call budget exceeded'])
		assert.equal(report.admitted, 4)
		assert.equal(report.rejected, 1)
	} else if (name === 'rpc-concurrent') {
		assert.equal(exitCode, 0, logs)
		assert.equal(result.length, 3)
		assert.equal(result.filter((value) => value === 'Concurrent RPC budget exceeded').length, 1)
		assert.equal(report.admitted, 2)
		assert.equal(report.rejected, 1)
		assert.equal(report.peakActive, 2)
	}
	const { logs: _logs, ...summary } = report
	return { case: name, ...summary }
}

const backend = await verifyBackend(image)
const reports = []
for (const name of selected === 'all' ? cases : [selected]) reports.push(await runCase(name))
console.log(JSON.stringify({ backend, image, reports }, null, 2))
