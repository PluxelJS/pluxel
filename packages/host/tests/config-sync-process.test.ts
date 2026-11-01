import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { HostConfigVersion } from '../src/index'
import { SuperJSON } from 'superjson'

type Reply = {
	config: { config: { value: string }; version: HostConfigVersion; code?: string; ok: boolean }
	sync: { savedVersion: HostConfigVersion; connection: string }
	updates: string[]
}
type Gate = { phase: string; document: string; version: HostConfigVersion; updates: string[] }
async function start(options: Record<string, unknown>) {
	const child = fork(
		fileURLToPath(new URL('./fixtures/config-sync-process.mjs', import.meta.url)),
		[JSON.stringify(options)],
		{
			execArgv: [
				'--import',
				fileURLToPath(new URL('../../rolldown/node_modules/tsx/dist/loader.mjs', import.meta.url)),
				'--conditions=@pluxel/source',
			],
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		},
	)
	let output = ''
	child.stdout!.on('data', (data: Buffer) => {
		output += data.toString()
	})
	child.stderr!.on('data', (data: Buffer) => {
		output += data.toString()
	})
	const pending = new Map<
		number,
		{
			resolve(value: unknown): void
			reject(error: Error): void
			timer: ReturnType<typeof setTimeout>
		}
	>()
	let sequence = 0
	const gate = Promise.withResolvers<Gate>()
	const ready = Promise.withResolvers<{ pid: number; url?: string; version: HostConfigVersion }>()
	child.on(
		'message',
		(message: {
			ready?: boolean
			gate?: Gate
			pid: number
			url?: string
			version: HostConfigVersion
			id?: number
			result?: unknown
			error?: string
		}) => {
			if (message.gate) gate.resolve(message.gate)
			else if (message.ready) ready.resolve(message)
			else if (message.id !== undefined) {
				const request = pending.get(message.id)
				if (!request) return
				pending.delete(message.id)
				clearTimeout(request.timer)
				if (message.error) request.reject(new Error(message.error))
				else request.resolve(message.result)
			}
		},
	)
	child.on('exit', (code) => {
		if (code !== 0) ready.reject(new Error(`Config process exited ${code}: ${output}`))
		for (const request of pending.values()) {
			clearTimeout(request.timer)
			request.reject(new Error(`Config process exited: ${output}`))
		}
		pending.clear()
	})
	const startupTimer = setTimeout(() => {
		ready.reject(new Error(`Config process startup timed out: ${output}`))
		child.kill()
	}, 15_000)
	let initial: Awaited<typeof ready.promise>
	try {
		initial = await ready.promise
	} finally {
		clearTimeout(startupTimer)
	}
	const call = (op: string, payload: Record<string, unknown> = {}): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = ++sequence
			const timer = setTimeout(() => {
				pending.delete(id)
				reject(new Error(`Config operation ${op} timed out: ${output}`))
			}, 10_000)
			pending.set(id, { resolve, reject, timer })
			child.send({ id, op, ...payload })
		})
	return {
		child,
		...initial,
		call,
		status: () => call('status') as Promise<Reply>,
		async waitForGate() {
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				return await Promise.race([
					gate.promise,
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`Config phase was not reached: ${output}`)),
							10_000,
						)
					}),
				])
			} finally {
				if (timer) clearTimeout(timer)
			}
		},
		async close() {
			if (child.exitCode !== null || child.signalCode !== null) return
			const exited = once(child, 'exit')
			await call('close')
			await exited
		},
	}
}
async function kill(child: ChildProcess | undefined) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return
	const exited = once(child, 'exit')
	child.kill('SIGKILL')
	await exited
}

it('replicates between real processes, survives disconnect/restart, and preserves saved history with its body', async () => {
	const root = await mkdtemp(fileURLToPath(new URL('./.config-sync-process-', import.meta.url)))
	let writer: Awaited<ReturnType<typeof start>> | undefined
	let replica: Awaited<ReturnType<typeof start>> | undefined
	try {
		writer = await start({ role: 'writer', data: join(root, 'writer') })
		const url = writer.url!
		const initial = writer.version
		await expect(
			writer.call('patch', { value: 'initial-saved', expected: initial }),
		).resolves.toMatchObject({ ok: true, version: { history: initial.history, seq: 1 } })
		replica = await start({ role: 'replica', data: join(root, 'replica'), url })
		expect(replica.pid).not.toBe(writer.pid)
		const firstStatus = await replica.status()
		expect(firstStatus.config).toMatchObject({
			config: { value: 'initial-saved' },
			version: { history: initial.history, seq: 1 },
		})
		await writer.call('patch', { value: 'second', expected: { history: initial.history, seq: 1 } })
		await expect
			.poll(async () => {
				const status = await replica!.status()
				return status.config.config.value
			})
			.toBe('second')
		const secondStatus = await replica.status()
		expect(secondStatus.updates).toEqual(['second'])
		await expect(
			writer.call('patch', { value: 'stale', expected: initial }),
		).resolves.toMatchObject({ ok: false, code: 'version_conflict', version: { seq: 2 } })
		await writer.close()
		await expect(
			replica.call('patch', {
				value: 'offline-write',
				expected: { history: initial.history, seq: 2 },
			}),
		).resolves.toMatchObject({ ok: false, code: 'mutation_rejected' })
		await replica.close()
		replica = await start({ role: 'replica', data: join(root, 'replica'), url })
		const reopenedStatus = await replica.status()
		expect(reopenedStatus.config).toMatchObject({
			config: { value: 'second' },
			version: { history: initial.history, seq: 2 },
		})
		writer = await start({
			role: 'writer',
			data: join(root, 'writer'),
			port: Number(new URL(url).port),
		})
		expect(writer.version).toEqual({ history: initial.history, seq: 2 })
		await writer.call('reset', { expected: writer.version })
		await expect
			.poll(
				async () => {
					const status = await replica!.status()
					return status.config.config.value
				},
				{ timeout: 5000 },
			)
			.toBe('seed')
		const finalStatus = await replica.status()
		expect(finalStatus.sync.savedVersion).toEqual({ history: initial.history, seq: 3 })
		expect(finalStatus.updates).toEqual(['seed'])
		await replica.close()
		await writer.close()
	} finally {
		await kill(replica?.child)
		await kill(writer?.child)
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it.each([
	{ phase: 'before-save', recoveredSequence: 0, recoveredValue: 'seed' },
	{ phase: 'after-save', recoveredSequence: 1, recoveredValue: 'candidate' },
])(
	'recovers the atomic saved version and body after SIGKILL at writer $phase',
	async ({ phase, recoveredSequence, recoveredValue }) => {
		const root = await mkdtemp(
			fileURLToPath(new URL('./.config-sync-writer-kill-', import.meta.url)),
		)
		let writer: Awaited<ReturnType<typeof start>> | undefined
		let replica: Awaited<ReturnType<typeof start>> | undefined
		try {
			writer = await start({ role: 'writer', data: join(root, 'writer') })
			const url = writer.url!
			const initial = writer.version
			replica = await start({ role: 'replica', data: join(root, 'replica'), url })
			await writer.call('arm', { phase, seq: 1 })
			const receipt = writer.call('patch', { value: 'candidate', expected: initial }).then(
				() => 'received',
				() => 'lost',
			)
			const gate = await writer.waitForGate()
			expect(gate.phase).toBe(phase)
			expect(gate.version).toEqual(initial)
			expect(gate.updates).toEqual([])
			const beforeSave = await replica.status()
			expect(beforeSave.config).toMatchObject({
				config: { value: 'seed' },
				version: initial,
			})
			await kill(writer.child)
			expect(await receipt).toBe('lost')
			writer = await start({
				role: 'writer',
				data: join(root, 'writer'),
				port: Number(new URL(url).port),
			})
			expect(writer.version).toEqual({ history: initial.history, seq: recoveredSequence })
			const recovered = await writer.status()
			expect(recovered.config).toMatchObject({
				config: { value: recoveredValue },
				version: writer.version,
			})
			await expect
				.poll(
					async () => {
						const status = await replica!.status()
						return status.config.version
					},
					{ timeout: 5000 },
				)
				.toEqual(writer.version)
			const replicated = await replica.status()
			expect(replicated.config.config.value).toBe(recoveredValue)
			await replica.close()
			await writer.close()
		} finally {
			await kill(replica?.child)
			await kill(writer?.child)
			await rm(root, { recursive: true, force: true })
		}
	},
	20_000,
)

it('recovers a confirmed writer commit killed before its broadcast response reaches the replica', async () => {
	const root = await mkdtemp(
		fileURLToPath(new URL('./.config-sync-broadcast-kill-', import.meta.url)),
	)
	let writer: Awaited<ReturnType<typeof start>> | undefined
	let replica: Awaited<ReturnType<typeof start>> | undefined
	try {
		writer = await start({ role: 'writer', data: join(root, 'writer') })
		const url = writer.url!
		const initial = writer.version
		replica = await start({ role: 'replica', data: join(root, 'replica'), url })
		await writer.call('arm', { phase: 'before-broadcast', seq: 1 })
		await expect(
			writer.call('patch', { value: 'confirmed', expected: initial }),
		).resolves.toMatchObject({ ok: true, version: { seq: 1 } })
		const gate = await writer.waitForGate()
		expect(gate.version).toEqual({ history: initial.history, seq: 1 })
		const beforeBroadcast = await replica.status()
		expect(beforeBroadcast.config.version).toEqual(initial)
		await kill(writer.child)
		writer = await start({
			role: 'writer',
			data: join(root, 'writer'),
			port: Number(new URL(url).port),
		})
		expect(writer.version).toEqual({ history: initial.history, seq: 1 })
		await expect
			.poll(
				async () => {
					const status = await replica!.status()
					return status.config.config.value
				},
				{ timeout: 5000 },
			)
			.toBe('confirmed')
		const afterBroadcast = await replica.status()
		expect(afterBroadcast.updates).toEqual(['confirmed'])
		await replica.close()
		await writer.close()
	} finally {
		await kill(replica?.child)
		await kill(writer?.child)
		await rm(root, { recursive: true, force: true })
	}
}, 20_000)

it('rebuilds application progress from a replica document saved before SIGKILL and before confirmation/application', async () => {
	const root = await mkdtemp(
		fileURLToPath(new URL('./.config-sync-replica-kill-', import.meta.url)),
	)
	let writer: Awaited<ReturnType<typeof start>> | undefined
	let replica: Awaited<ReturnType<typeof start>> | undefined
	try {
		writer = await start({ role: 'writer', data: join(root, 'writer') })
		const url = writer.url!
		const initial = writer.version
		replica = await start({ role: 'replica', data: join(root, 'replica'), url })
		await replica.call('arm', { phase: 'after-save', seq: 1 })
		await writer.call('patch', { value: 'saved-before-application', expected: initial })
		const gate = await replica.waitForGate()
		expect(gate.version).toEqual(initial)
		expect(gate.updates).toEqual([])
		expect(SuperJSON.parse(gate.document)).toMatchObject({ history: initial.history, seq: 1 })
		await kill(replica.child)
		await writer.close()
		replica = await start({ role: 'replica', data: join(root, 'replica'), url })
		const recovered = await replica.status()
		expect(recovered.config).toMatchObject({
			config: { value: 'saved-before-application' },
			version: { history: initial.history, seq: 1 },
			application: 'applied',
		})
		expect(recovered.updates).toEqual([])
		expect(recovered.sync.savedVersion).toEqual({ history: initial.history, seq: 1 })
		await replica.close()
	} finally {
		await kill(replica?.child)
		await kill(writer?.child)
		await rm(root, { recursive: true, force: true })
	}
}, 20_000)

it('queries the current saved version after losing a real HTTP management receipt without replaying stale edits', async () => {
	const root = await mkdtemp(
		fileURLToPath(new URL('./.config-sync-lost-receipt-', import.meta.url)),
	)
	let writer: Awaited<ReturnType<typeof start>> | undefined
	try {
		writer = await start({ role: 'writer', data: join(root, 'writer') })
		const initial = writer.version
		await expect(
			fetch(new URL('/manage', writer.url), {
				method: 'POST',
				body: JSON.stringify({ value: 'lost-receipt', expected: initial, dropReply: true }),
			}),
		).rejects.toThrow('fetch failed')
		const observed = await writer.status()
		expect(observed.config).toMatchObject({
			config: { value: 'lost-receipt' },
			version: { history: initial.history, seq: 1 },
		})
		await writer.call('patch', { value: 'later-edit', expected: observed.config.version })
		const current = await writer.status()
		expect(current.config).toMatchObject({
			config: { value: 'later-edit' },
			version: { history: initial.history, seq: 2 },
		})
		await expect(
			writer.call('patch', { value: 'lost-receipt', expected: initial }),
		).resolves.toMatchObject({
			ok: false,
			code: 'version_conflict',
			version: current.config.version,
		})
		await writer.close()
	} finally {
		await kill(writer?.child)
		await rm(root, { recursive: true, force: true })
	}
}, 20_000)
