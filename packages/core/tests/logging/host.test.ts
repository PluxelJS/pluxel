import { requireHostDocuments, requireFs } from '@pluxel/core/internal'
import * as nativeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/core'
import { getContextLoggerRootId } from '@pluxel/core/host'
import { createHost } from '@pluxel/host'
import { Passthrough } from '@pluxel/core/fs'
import { logtape, zenfs } from '@pluxel/core/config'
import { expect, it } from 'vitest'
import type { LogRecord } from '@logtape/logtape'
import {
	markLogs,
	readLogs,
	waitForLogs,
	createPluginLogPolicyStore,
	parsePluginLogPolicySnapshot,
	type PluginLogPolicySnapshot,
	type RuntimeLoggingInput,
} from '../../src/logging/index'

@Plugin({ forkable: true })
class LoggedOwner extends BasePlugin {
	init() {
		this.ctx.logger.info('owner started')
	}
}
const plan: RuntimeLoggingInput = ({ createRuntimeLogSink }) => ({
	sinks: { memory: createRuntimeLogSink({ caller: false, bufferSize: 1, flushIntervalMs: 0 }) },
	loggers: [
		{ category: ['pluxel', 'runtime'], sinks: ['memory'], lowestLevel: 'trace' },
		{ category: ['pluxel', 'plugins'], sinks: ['memory'], lowestLevel: 'trace' },
		{ category: ['logtape', 'meta'], lowestLevel: null },
	],
})

it('creates a fresh owner for each Host and rejects records from a retired root', async () => {
	const records: LogRecord[] = []
	const declaration = logtape({
		sinks: { native: (record) => records.push(record) },
		loggers: [{ category: ['pluxel', 'runtime'], sinks: ['native'] }],
	})
	const first = await createHost({ plugins: [], runtime: { logtape: declaration }, services: [] })
	const oldLogger = first.ctx.logger
	const oldId = first.ctx.logging!.resolved.root.id
	await first.close()
	const second = await createHost({ plugins: [], runtime: { logtape: declaration }, services: [] })
	try {
		expect(second.ctx.logging!.resolved.root.id).not.toBe(oldId)
		oldLogger.info('retired root')
		second.ctx.logger.info('current root')
		expect(records.some((record) => record.message.join('') === 'retired root')).toBe(false)
		expect(records.some((record) => record.message.join('') === 'current root')).toBe(true)
		expect(second.ctx.logging!.describe().diagnostics.wrongRootRecords).toBe(1)
	} finally {
		await second.close()
	}
})

it('bounds log cursors to their Host and stream, and releases waits on delivery, reset and abort', async () => {
	const host = await createHost({ plugins: [], runtime: { logtape: logtape(plan) }, services: [] })
	try {
		const manager = host.ctx.logging!
		const empty = markLogs(manager)
		expect(readLogs(manager, empty)).toMatchObject({ ok: true, lines: [] })
		expect(() => markLogs(manager, 'not-configured')).toThrow('Log store is not installed')
		host.ctx.logger.info('before mark')
		const cursor = markLogs(manager)
		const store = manager.stores.get('default')!
		const controller = new AbortController()
		const pending = waitForLogs(manager, cursor, { signal: controller.signal })
		expect(store.subscriberCount).toBe(1)
		host.ctx.logger.info('after mark')
		const delivered = await pending
		expect(delivered.ok && delivered.lines.map((line) => line.msg)).toEqual(['after mark'])
		expect(store.subscriberCount).toBe(0)
		expect(readLogs(manager, { ...cursor, rootId: 'another-host' })).toMatchObject({
			code: 'root_mismatch',
		})
		expect(readLogs(manager, { ...cursor, bootId: 'another-stream' })).toMatchObject({
			code: 'stream_replaced',
		})
		expect(readLogs(manager, { ...cursor, streamId: 'missing' })).toMatchObject({
			code: 'store_unavailable',
		})
		const reset = waitForLogs(manager, markLogs(manager), { signal: controller.signal })
		store.reset()
		await expect(reset).resolves.toMatchObject({ code: 'epoch_mismatch' })
		expect(store.subscriberCount).toBe(0)
		const aborted = waitForLogs(manager, markLogs(manager), { signal: controller.signal })
		const reason = new Error('operation cancelled')
		controller.abort(reason)
		await expect(aborted).rejects.toBe(reason)
		expect(store.subscriberCount).toBe(0)
		await expect(waitForLogs(manager, cursor, { signal: controller.signal })).rejects.toBe(reason)
	} finally {
		await host.close()
	}
})

it('binds the Core identity and retries durable fork policy cleanup through the Host gate', async () => {
	let failWrite = false
	const writes: PluginLogPolicySnapshot[] = []
	const host = await createHost({
		plugins: [LoggedOwner],
		runtime: {
			logtape: logtape(plan, {
				policyLoadFailure: 'fail',
				policyStore(root) {
					const documents = requireFs(root).documents('services/logging')
					return createPluginLogPolicyStore({
						getText: (key) => documents.getText(key),
						async put(key, value) {
							if (failWrite) throw new Error('policy unavailable')
							await documents.put(key, value)
							writes.push(parsePluginLogPolicySnapshot(value))
						},
					})
				},
			}),
		},
		services: [],
	})
	const manager = host.ctx.logging!
	try {
		expect(manager.resolved.root.id).toBe(getContextLoggerRootId(host.ctx))
		await expect(
			createHost({ plugins: [], runtime: { logtape: logtape(plan) }, services: [] }),
		).rejects.toThrow('Another RuntimeLogging instance')
		const base = LoggedOwner.nodeAddress()
		const ensured = await host.forks.ensure(base, 'policy', { autoStart: true })
		expect(ensured.ok).toBe(true)
		if (!ensured.ok) throw new Error('fork creation failed')
		const fork = { ...base, variant: 'fork' as const, forkId: 'policy' }
		await host.startNode(fork)
		expect(
			manager.stores
				.getOrCreate('default')
				.tailWindow(10)
				.some((line) => line.msg.includes('owner started')),
		).toBe(true)
		manager.policy.setPluginLevel(fork, 'debug')
		await manager.policy.flush()
		failWrite = true
		await expect(host.forks.remove(base, 'policy')).resolves.toMatchObject({ ok: false })
		expect(manager.policy.persistence).toBe('failed')
		failWrite = false
		await expect(host.forks.remove(base, 'policy')).resolves.toMatchObject({ ok: true })
		expect(writes.at(-1)?.overrides).toEqual([])
	} finally {
		failWrite = false
		await host.close()
	}
	expect(manager.state).toBe('disposed')
})

it('restores TinyBase policy documents, flushes before FS final closure and keeps profiles separate', async () => {
	const directory = await nativeFs.promises.mkdtemp(join(tmpdir(), 'pluxel-logging-fs-'))
	let factoryCalls = 0
	const logger = (profile: string) =>
		logtape(plan, {
			profile,
			policyStore(root) {
				factoryCalls++
				return createPluginLogPolicyStore(requireHostDocuments(root, 'logging'))
			},
		})
	const owner = LoggedOwner.nodeAddress()
	const config = {
		zenfs: zenfs({
			mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix: directory } },
			durableMounts: ['/'],
		}),
	}
	try {
		const first = await createHost({
			plugins: [],
			runtime: { ...config, logtape: logger('first') },
			services: [],
		})
		try {
			first.ctx.logging!.policy.setPluginLevel(owner, 'debug')
		} finally {
			await first.close()
		}
		const inspect = await createHost({
			plugins: [],
			runtime: config,
			services: [],
		})
		try {
			const firstDocument = await requireHostDocuments(inspect.ctx, 'logging').getText(
				'plugin-policy/first.json',
			)
			expect(parsePluginLogPolicySnapshot(firstDocument!).overrides).toEqual([
				{ owner, level: 'debug' },
			])
		} finally {
			await inspect.close()
		}
		const second = await createHost({
			plugins: [],
			runtime: { ...config, logtape: logger('second') },
			services: [],
		})
		try {
			expect(second.ctx.logging!.policy.snapshot().overrides).toEqual([])
			second.ctx.logging!.policy.setDefaultLevel('warning')
		} finally {
			await second.close()
		}
		const reopened = await createHost({
			plugins: [],
			runtime: { ...config, logtape: logger('first') },
			services: [],
		})
		try {
			expect(reopened.ctx.logging!.policy.snapshot().overrides).toEqual([{ owner, level: 'debug' }])
			expect(reopened.ctx.logging!.policy.snapshot().defaultLevel).toBe('info')
		} finally {
			await reopened.close()
		}
		expect(factoryCalls).toBe(3)
	} finally {
		await nativeFs.promises.rm(directory, { recursive: true, force: true })
	}
})
