import { createHash } from 'node:crypto'
import { chmod, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { cli as gunshiCli } from 'gunshi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { devCommand } from '../src/commands/dev'
import { normalizeDevArgs } from '../src/command-manifest'
import { decodeDevReceipt, encodeDevReceipt } from '../src/dev/receipt'
import {
	DevClientError,
	connectDevInstance,
	controlDevHmr,
	discoverDevInstances,
	liveDevInstances,
	parseInput,
	parseRunSnapshot,
	publicInstance,
	runDevFile,
	selectDevInstance,
} from '../src/dev/client'
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
			normalizeDevArgs(['dev', ...argv]),
			{ run() {} },
			{ subCommands: { dev: devCommand } },
		)
	} finally {
		output?.mockRestore()
	}
}

describe('development control through native Capn Web', () => {
	it('discovers and authenticates the exact owner without exposing private carrier credentials', async () => {
		const { root, instance, requests } = await fixture({
			metadata: {
				application: { state: 'unavailable', latestUpdate: null },
				hmr: { mode: 'paused' },
			},
		})
		expect(await discoverDevInstances(root)).toEqual([instance])
		expect(await liveDevInstances(root)).toEqual([instance])
		expect(requests.map((request) => request.method)).toEqual(['connect', 'describe'])
		expect(publicInstance(instance)).not.toHaveProperty('nonce')
		expect(publicInstance(instance)).not.toHaveProperty('socketPath')
		expect(await selectDevInstance({ root })).toEqual(instance)
	})
	it('requires explicit selection among owners with the same root', async () => {
		const first = await fixture()
		const second = await fixture({ root: first.root })
		await expect(selectDevInstance({ root: first.root })).rejects.toMatchObject({
			code: 'ambiguous_instance',
			candidates: expect.arrayContaining([
				expect.objectContaining({ instanceId: first.instance.instanceId }),
				expect.objectContaining({ instanceId: second.instance.instanceId }),
			]),
		})
		expect(
			await selectDevInstance({ root: first.root, instance: second.instance.instanceId }),
		).toEqual(second.instance)
	})
	it('rejects wrong credentials before granting an execution target', async () => {
		const { instance, executor } = await fixture()
		await expect(connectDevInstance({ ...instance, nonce: 'wrong' })).rejects.toMatchObject({
			code: 'unauthorized',
		})
		expect(() => executor.result('never-submitted', instance.instanceId)).toThrow(
			expect.objectContaining({ code: 'run_not_found' }),
		)
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
	it('submits source hash and explicit input once, then queries the retained result', async () => {
		const { root, instance, requests } = await fixture()
		const file = await script(root)
		const events: string[] = []
		const result = await runDevFile({
			instance,
			file,
			exportName: 'default',
			input: { count: 3 },
			timeoutMs: 500,
			detach: false,
			onPrepared(snapshot) {
				events.push(snapshot.state)
				expect(snapshot.requestHash).toMatch(/^[a-f0-9]{64}$/)
				expect(requests.some((request) => request.method === 'submit')).toBe(false)
			},
			onAccepted: () => events.push('accepted'),
		})
		expect(result).toMatchObject({
			state: 'succeeded',
			root,
			value: { input: { count: 3 }, exportName: 'default' },
		})
		expect(events).toEqual(['submitting', 'accepted'])
		const submissions = requests.filter((request) => request.method === 'submit')
		expect(submissions).toHaveLength(1)
		expect(submissions[0]?.input).toMatchObject({
			protocol: 2,
			instanceId: instance.instanceId,
			code: {
				kind: 'project',
				file,
				sourceHash: createHash('sha256')
					.update('export default async () => ({ answer: 42 })\n')
					.digest('hex'),
			},
			input: { count: 3 },
		})
		expect(requests.some((request) => request.method === 'result')).toBe(true)
	})
	it('queries the original request after a lost admission response without replaying it', async () => {
		let executions = 0
		const { root, instance, requests, executor } = await fixture({
			dropAdmissionResponse: true,
			execute: async () => {
				executions++
				return { changed: true }
			},
		})
		const failure = await runDevFile({
			instance,
			file: await script(root),
			exportName: 'default',
			timeoutMs: 1000,
			detach: false,
		}).then(
			() => {
				throw new Error('Expected a lost response')
			},
			(error: unknown) => error as { code: string; runId: string; requestHash: string },
		)
		expect(failure).toMatchObject({
			code: 'outcome_unknown',
			runId: expect.any(String),
			requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		})
		expect(await executor.settled(failure.runId, instance.instanceId)).toMatchObject({
			state: 'succeeded',
			value: { changed: true },
		})
		using connection = await connectDevInstance(instance)
		expect(await connection.result(failure.runId)).toMatchObject({
			runId: failure.runId,
			state: 'succeeded',
		})
		expect(requests.filter((request) => request.method === 'submit')).toHaveLength(1)
		expect(executions).toBe(1)
	})
	it('keeps cancellation pending until the actual script settles', async () => {
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>()
		const { root, instance, executor } = await fixture({
			execute: async (_input, run) => {
				entered.resolve()
				await release.promise
				run.signal.throwIfAborted()
			},
		})
		try {
			const accepted = await runDevFile({
				instance,
				file: await script(root),
				exportName: 'default',
				timeoutMs: 1000,
				detach: true,
			})
			await entered.promise
			using connection = await connectDevInstance(instance)
			expect(await connection.cancel(accepted.runId)).toMatchObject({ state: 'cancelling' })
			expect(await connection.result(accepted.runId)).toMatchObject({ state: 'cancelling' })
			release.resolve()
			expect(await executor.settled(accepted.runId, instance.instanceId)).toMatchObject({
				state: 'cancelled',
				error: { code: 'cancelled' },
			})
		} finally {
			release.resolve()
		}
	})
	it.each(['pause', 'apply', 'resume'])(
		'controls %s without a ready application or project module',
		async (action) => {
			const { instance, requests } = await fixture({
				metadata: { application: { state: 'unavailable', latestUpdate: null } },
			})
			expect(
				await controlDevHmr({ instance, action, timeoutMs: 500, detach: false }),
			).toMatchObject({ kind: 'hmr', state: 'succeeded', value: { action } })
			expect(requests.filter((request) => request.method === 'control')).toHaveLength(1)
			expect(requests.some((request) => request.method === 'submit')).toBe(false)
		},
	)
	it('admits HMR while a script is awaiting its update', async () => {
		const apply = Promise.withResolvers<void>()
		const { root, instance } = await fixture({
			execute: async () => {
				await apply.promise
				return 'updated'
			},
			control: async () => {
				apply.resolve()
				return { mode: 'paused' }
			},
		})
		try {
			const running = runDevFile({
				instance,
				file: await script(root),
				exportName: 'default',
				timeoutMs: 1000,
				detach: false,
			})
			expect(
				await controlDevHmr({ instance, action: 'apply', timeoutMs: 1000, detach: false }),
			).toMatchObject({ state: 'succeeded' })
			expect(await running).toMatchObject({ state: 'succeeded', value: 'updated' })
		} finally {
			apply.resolve()
		}
	})
	it('pins result and cancel receipts to the original instance after a new instance appears', async () => {
		const first = await fixture()
		const accepted = await runDevFile({
			instance: first.instance,
			file: await script(first.root),
			exportName: 'default',
			timeoutMs: 500,
			detach: false,
		})
		const token = encodeDevReceipt({
			...first.instance,
			runId: accepted.runId,
			requestHash: accepted.requestHash as string,
		})
		const second = await fixture({ root: first.root })
		for (const command of ['result', 'cancel']) {
			const output: string[] = []
			await cli([command, token], { log: (value) => output.push(String(value)) })
			expect(JSON.parse(output[0]!)).toMatchObject({
				ok: true,
				value: { instanceId: first.instance.instanceId, runId: accepted.runId, state: 'succeeded' },
			})
		}
		expect(
			second.requests.some((request) => !['connect', 'describe'].includes(request.method)),
		).toBe(false)
	})
	it('prints a receipt before submission while stdout contains a single final result', async () => {
		const { root, instance } = await fixture()
		const output: string[] = [],
			events: Record<string, unknown>[] = []
		vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
			try {
				events.push(JSON.parse(String(chunk)))
			} catch {
				/* Presentation output is not a receipt. */
			}
			return true
		})
		await cli(['run', await script(root), '--root', root], {
			log: (value) => output.push(String(value)),
		})
		expect(output).toHaveLength(1)
		const result = JSON.parse(output[0]!)
		expect(result).toMatchObject({ ok: true, value: { state: 'succeeded' } })
		expect(events.map((event) => event.event)).toEqual(['submitting', 'accepted'])
		expect(decodeDevReceipt(String(events[0]?.receipt))).toMatchObject({
			instanceId: instance.instanceId,
			requestHash: result.value.requestHash,
		})
		expect(events[0]?.receipt).toBe(result.value.receipt)
		expect(output[0]).not.toContain(instance.nonce)
	})
	it('rejects an input-file conflict before connecting', async () => {
		const { root, requests } = await fixture()
		const output: string[] = []
		await cli(
			['run', await script(root), '--root', root, '--input', '{}', '--input-file', 'missing.json'],
			{ log: (value) => output.push(String(value)) },
		)
		expect(JSON.parse(output[0]!)).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
		expect(requests).toHaveLength(0)
	})
	it('rejects a source symlink escaping the selected root before submission', async () => {
		const first = await fixture(),
			outside = await fixture()
		const linked = resolve(first.root, 'linked.ts')
		await symlink(await script(outside.root), linked)
		await expect(
			runDevFile({
				instance: first.instance,
				file: linked,
				exportName: 'default',
				timeoutMs: 500,
				detach: false,
			}),
		).rejects.toMatchObject({ code: 'invalid_input' })
		expect(first.requests.some((request) => request.method === 'submit')).toBe(false)
	})
	it('rejects excessive JSON and mismatched result identities', () => {
		expect(parseInput('{"a":[1,true,null]}')).toEqual({ a: [1, true, null] })
		for (const value of [
			'{',
			'1e999',
			'"' + 'a'.repeat(1024 * 1024) + '"',
			'['.repeat(65) + '0' + ']'.repeat(65),
		])
			expect(() => parseInput(value)).toThrow(DevClientError)
		expect(() =>
			parseRunSnapshot(
				{ state: 'succeeded' },
				{ instanceId: 'expected', root: '/' } as never,
				'run',
			),
		).toThrow(expect.objectContaining({ code: 'protocol_mismatch' }))
	})
})
