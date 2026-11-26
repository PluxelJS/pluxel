import {
	runScript,
	getScriptResult,
	cancelScript,
	listHosts,
	HostClientError,
} from '@pluxel/agent-sdk/client'
import { SCRIPT_PROTOCOL } from '@pluxel/host/internal/agent/runtime'
import { chmod, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { cli as gunshiCli, define } from 'gunshi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	scriptCommand,
	normalizeDevArgs,
	devCommonArgs,
	devSubCommands,
} from '@pluxel/agent-sdk/internal/cli'
const devCommand = define({ name: 'dev', args: devCommonArgs, subCommands: devSubCommands })
import { connectDevInstance, discoverDevInstances, selectDevInstance } from '../src/client/dev'
import { decodeScriptReceipt } from '../src/client/receipt'
import { createDevFixture } from './helpers/dev-fixture'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	process.exitCode = 0
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	for (const close of cleanup.splice(0).toReversed()) await close()
})
async function fixture(options: Parameters<typeof createDevFixture>[0] = {}) {
	const result = await createDevFixture(options)
	cleanup.push(() => result.close())
	return result
}
async function script(root: string, name = 'operation.ts') {
	const file = resolve(root, name)
	await writeFile(file, 'export default async () => ({ answer: 42 })\n')
	return file
}
async function cli(argv: string[], options: { log?(value: string): void } = {}) {
	const output = options.log ? vi.spyOn(console, 'log').mockImplementation(options.log) : undefined
	try {
		return await gunshiCli(
			normalizeDevArgs(argv[0] === 'script' ? argv : ['dev', ...argv]),
			{ run() {} },
			{ subCommands: { dev: devCommand, script: scriptCommand } },
		)
	} finally {
		output?.mockRestore()
	}
}

describe('development control through native Capn Web', () => {
	it.skipIf(process.platform === 'win32')(
		'discovers a live console beside a socket left by an exited listener',
		async () => {
			const { root, instance, directory } = await fixture()
			const boundPath = resolve(dirname(instance.socketPath), 'bound.sock')
			const stalePath = resolve(dirname(instance.socketPath), 'stale.sock')
			const listener = createServer()
			await new Promise<void>((done, reject) => {
				listener.once('error', reject)
				listener.listen(boundPath, done)
			})
			try {
				await rename(boundPath, stalePath)
			} finally {
				await new Promise<void>((done, reject) =>
					listener.close((error) => (error ? reject(error) : done())),
				)
			}
			const stale = { ...instance, instanceId: 'stale', socketPath: stalePath }
			await writeFile(resolve(directory, 'stale.json'), JSON.stringify(stale), { mode: 0o600 })

			await expect(selectDevInstance({ root })).resolves.toEqual(instance)
			await expect(connectDevInstance(stale)).rejects.toMatchObject({
				code: 'dev_unavailable',
				cause: { code: 'ECONNREFUSED' },
			})
		},
	)
	it('reports the exact incompatible record and safe protocol facts through the public client', async () => {
		const { root, directory } = await fixture()
		const recordFile = resolve(directory, 'obsolete.json')
		await writeFile(
			recordFile,
			JSON.stringify({
				protocol: SCRIPT_PROTOCOL - 1,
				nonce: 'private-nonce',
				socketPath: 'private-socket',
			}),
			{ mode: 0o600 },
		)
		const error = await listHosts({ root }).catch((cause) => cause)
		expect(error).toBeInstanceOf(HostClientError)
		expect(error).toMatchObject({
			code: 'protocol_mismatch',
			failure: {
				context: {
					root,
					recordFile,
					expectedProtocol: SCRIPT_PROTOCOL,
					actualProtocol: SCRIPT_PROTOCOL - 1,
				},
				hint: expect.stringContaining('confirming its console has stopped'),
			},
		})
		expect(JSON.stringify(error.failure)).not.toContain('private-nonce')
		expect(JSON.stringify(error.failure)).not.toContain('private-socket')
		const output: string[] = []
		await cli(['instances', '--root', root], { log: (value) => output.push(value) })
		expect(output.map((value) => JSON.parse(value))).toMatchObject([
			{ ok: false, error: { code: 'protocol_mismatch', context: error.failure.context } },
		])
	})
	it('reads only the explicitly selected owner for execution and original receipt recovery', async () => {
		const { root, directory, instance } = await fixture()
		await writeFile(resolve(directory, 'obsolete.json'), '{', { mode: 0o600 })
		const file = await script(root)
		const { receipt, run } = await runScript({
			target: { root, instance: instance.instanceId },
			file,
		})
		expect(run).toMatchObject({ state: 'succeeded', instanceId: instance.instanceId })
		const queried = await getScriptResult(receipt)
		const cancelled = await cancelScript(receipt)
		expect(queried.run).toEqual(run)
		expect(cancelled.run).toEqual(run)
		await expect(discoverDevInstances(root)).rejects.toMatchObject({
			code: 'invalid_discovery',
			context: { root, recordFile: resolve(directory, 'obsolete.json') },
		})
	})
	it('validates the selected record instead of bypassing its protocol or escaping the directory', async () => {
		const { root, instance, record } = await fixture()
		await writeFile(record, JSON.stringify({ protocol: 'private-invalid-protocol' }))
		const error = await selectDevInstance({ root, instance: instance.instanceId }).catch(
			(cause) => cause,
		)
		expect(error).toMatchObject({
			code: 'protocol_mismatch',
			context: {
				root,
				instanceId: instance.instanceId,
				recordFile: record,
				expectedProtocol: SCRIPT_PROTOCOL,
				actualProtocol: null,
			},
		})
		expect(JSON.stringify(error)).not.toContain('private-invalid-protocol')
		await expect(selectDevInstance({ root, instance: '../outside' })).rejects.toMatchObject({
			code: 'invalid_input',
			context: { root },
		})
	})
	it.skipIf(process.platform === 'win32')(
		'rejects public discovery records and symlinks',
		async () => {
			const { root, directory, record } = await fixture()
			await chmod(record, 0o644)
			await expect(discoverDevInstances(root)).rejects.toMatchObject({
				code: 'discovery_permissions',
			})
			await chmod(record, 0o600)
			await symlink(record, resolve(directory, 'other.json'))
			await expect(discoverDevInstances(root)).rejects.toMatchObject({ code: 'invalid_discovery' })
		},
	)
	it.skipIf(process.platform === 'win32')(
		'keeps directory and selected-record permission checks for exact owners',
		async () => {
			const { root, directory, record, instance } = await fixture()
			try {
				await chmod(directory, 0o755)
				await expect(
					selectDevInstance({ root, instance: instance.instanceId }),
				).rejects.toMatchObject({
					code: 'discovery_permissions',
					context: { root },
				})
				await chmod(directory, 0o700)
				await chmod(record, 0o644)
				await expect(
					selectDevInstance({ root, instance: instance.instanceId }),
				).rejects.toMatchObject({
					code: 'discovery_permissions',
					context: { root, recordFile: record },
				})
			} finally {
				await chmod(directory, 0o700)
				await chmod(record, 0o600)
			}
		},
	)
	it('recovers a receipt from its original instance and never falls through to its replacement', async () => {
		const first = await fixture()
		const { receipt, run } = await runScript({
			target: { root: first.root },
			file: await script(first.root),
			input: { count: 3 },
		})
		expect(run).toMatchObject({
			state: 'succeeded',
			instanceId: first.instance.instanceId,
			value: { input: { count: 3 } },
		})
		const replacement = await fixture({ root: first.root })
		await expect(listHosts({ root: first.root })).resolves.toMatchObject({
			instances: expect.arrayContaining([
				expect.objectContaining({ instanceId: first.instance.instanceId }),
				expect.objectContaining({ instanceId: replacement.instance.instanceId }),
			]),
		})
		await expect(
			runScript({ target: { root: first.root }, file: await script(first.root) }),
		).rejects.toMatchObject({ code: 'ambiguous_instance' })
		await expect(getScriptResult(receipt)).resolves.toEqual({ receipt, run })
		await rm(first.record)
		await expect(cancelScript(receipt)).rejects.toMatchObject({
			code: 'dev_unavailable',
			receipt,
			failure: { context: { root: first.root, instanceId: first.instance.instanceId } },
		})
		expect(replacement.requests.some(({ method }) => method === 'cancel')).toBe(false)
	})
	it('persists a receipt before executing HMR and leaves stdout as one final result', async () => {
		let receiptFile = ''
		const readSaved = () => readFile(receiptFile, 'utf8')
		const { root, instance, requests } = await fixture({ control: readSaved })
		receiptFile = resolve(root, 'operation.receipt')
		const output: string[] = []
		const events: Record<string, unknown>[] = []
		const submitted: boolean[] = []
		vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			const event = JSON.parse(String(chunk))
			events.push(event)
			submitted.push(requests.some(({ method }) => method === 'submit' || method === 'control'))
			return true
		})
		await cli(['hmr', 'pause', '--root', root, '--receipt-file', receiptFile], {
			log: (value) => output.push(String(value)),
		})
		expect(output).toHaveLength(1)
		const result = JSON.parse(output[0]!)
		expect(result).toMatchObject({
			ok: true,
			value: { run: { state: 'succeeded', value: result.value.receipt + '\n' } },
		})
		expect(events).toEqual([
			{ stage: 'prepared', receipt: result.value.receipt },
			{ stage: 'accepted', receipt: result.value.receipt },
		])
		expect(decodeScriptReceipt(result.value.receipt)).toMatchObject({
			instanceId: instance.instanceId,
			requestHash: result.value.run.requestHash,
		})
		expect(submitted).toEqual([false, true])
		expect(process.exitCode).toBe(0)
	})
	it('does not submit when receipt persistence fails', async () => {
		const { root, instance, requests } = await fixture()
		const receiptFile = resolve(root, 'operation.receipt')
		await writeFile(receiptFile, 'previous receipt')
		const progress = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
		const output: string[] = []
		await cli(['hmr', 'pause', '--root', root, '--receipt-file', receiptFile], {
			log: (value) => output.push(String(value)),
		})
		expect(output).toHaveLength(1)
		const failure = JSON.parse(output[0]!)
		expect(failure).toMatchObject({
			ok: false,
			error: { code: 'EEXIST', receipt: expect.any(String) },
		})
		expect(decodeScriptReceipt(failure.error.receipt)).toMatchObject({
			instanceId: instance.instanceId,
		})
		expect(await readFile(receiptFile, 'utf8')).toBe('previous receipt')
		expect(requests.some(({ method }) => method === 'submit' || method === 'control')).toBe(false)
		expect(progress).not.toHaveBeenCalled()
		expect(process.exitCode).toBe(1)
	})
	it('recovers a saved receipt after a lost local admission response without resubmitting', async () => {
		const { root, instance, executor, requests } = await fixture({ dropAdmissionResponse: true })
		const receiptFile = resolve(root, 'operation.receipt')
		const progress = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
		const output: string[] = []
		await cli(['run', await script(root), '--root', root, '--receipt-file', receiptFile], {
			log: (value) => output.push(String(value)),
		})
		const failure = JSON.parse(output[0]!)
		expect(failure).toMatchObject({
			ok: false,
			error: { code: 'outcome_unknown', hint: expect.stringContaining('pluxel script result') },
		})
		const saved = await readFile(receiptFile, 'utf8')
		const receipt = saved.slice(0, -1)
		expect(failure.error.receipt).toBe(receipt)
		expect(progress).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ stage: 'prepared', receipt }) + '\n',
		)
		const original = decodeScriptReceipt(receipt)
		await executor.settled(original.runId, instance.instanceId)
		output.length = 0
		await cli(['script', 'result', '--receipt-file', receiptFile], {
			log: (value) => output.push(String(value)),
		})
		expect(JSON.parse(output[0]!)).toMatchObject({
			ok: true,
			value: { receipt, run: { runId: original.runId, state: 'succeeded' } },
		})
		expect(requests.filter(({ method }) => method === 'submit')).toHaveLength(1)
		expect(process.exitCode).toBe(0)
	})
	it('rejects a source symlink escaping the selected root before submission', async () => {
		const first = await fixture(),
			outside = await fixture()
		const linked = resolve(first.root, 'linked.ts')
		await symlink(await script(outside.root), linked)
		await expect(
			runScript({
				target: { root: first.instance.root, instance: first.instance.instanceId },
				file: linked,
				exportName: 'default',
				timeoutMs: 500,
				detach: false,
			}).then(({ run }) => run),
		).rejects.toMatchObject({ code: 'invalid_input' })
		expect(first.requests.some((request) => request.method === 'submit')).toBe(false)
	})
})
