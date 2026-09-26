import { RpcTarget, RpcStub } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'

import { createRuntimeManagementClient } from '../../../src/management/web/client.ts'
import { RUNTIME_MANAGEMENT_CAPABILITIES } from '../../../src/management/web/protocol.ts'
import type {
	RuntimeLogObserver,
	RuntimeManagementTarget,
} from '../../../src/management/web/management-target.ts'

const metadata = Object.freeze({
	service: 'pluxel-runtime' as const,
	ready: true as const,
	protocol: Object.freeze({
		name: 'pluxel.management' as const,
		major: 7 as const,
		capabilities: RUNTIME_MANAGEMENT_CAPABILITIES,
	}),
	application: Object.freeze({ product: null }),
	platform: Object.freeze({
		runtime: Object.freeze({ name: 'node', version: '24.0.0' }),
		deployment: Object.freeze({ provider: null, ci: false }),
		mode: 'test' as const,
		platform: 'linux',
	}),
	workbench: Object.freeze({ enabled: false }),
})

const logMeta = Object.freeze({
	streamId: 'default',
	bootId: 'boot-1',
	epoch: 1,
	headSeq: '1',
	tailSeq: '0',
	nextSeq: '1',
	count: 0,
	retention: Object.freeze({ windowLines: 200_000 }),
})

describe('injected Runtime Management client', () => {
	it('projects one borrowed capability without fetch, discovery, or transport options', async () => {
		const subscriptionDispose = vi.fn()
		const target = {
			describeDto: vi.fn(async () => metadata),
			pluginCatalogDto: vi.fn(async () => ({
				plugins: [],
				sections: [],
				summary: { total: 0, running: 0, stopped: 0, autoStart: 0 },
			})),
			updatePluginCatalogLayoutDto: vi.fn(async () => ({ ok: true, sections: [] })),
			logStreamsDto: vi.fn(async () => ({ streams: [logMeta] })),
			logMetaDto: vi.fn(async () => logMeta),
			logRangeDto: vi.fn(async () => ({
				ok: true,
				streamId: 'default',
				epoch: 1,
				fromSeq: '1',
				nextSeq: '1',
				lines: [],
			})),
			followLogs: vi.fn(async (_input: unknown, observer: RuntimeLogObserver) => {
				await observer({
					type: 'gap',
					streamId: 'default',
					epoch: 1,
					missingFrom: '1',
					missingTo: '4',
				})
				return new (class extends RpcTarget {
					[Symbol.dispose]() {
						subscriptionDispose()
					}
				})()
			}),
		} as unknown as RpcStub<RuntimeManagementTarget>

		const client = createRuntimeManagementClient(target)
		await expect(client.describe()).resolves.toEqual(metadata)
		await expect(client.catalog.snapshot()).resolves.toEqual({
			plugins: [],
			sections: [],
			summary: { total: 0, running: 0, stopped: 0, autoStart: 0 },
		})
		await expect(client.catalog.updateLayout({ sections: [] })).resolves.toEqual({
			ok: true,
			sections: [],
		})
		await client.catalog.updateLayout({ sections: null })
		expect(target.updatePluginCatalogLayoutDto).toHaveBeenLastCalledWith({ sections: null })
		await expect(client.logs.streams()).resolves.toEqual({ streams: [logMeta] })
		await expect(
			client.logs.range('default', { epoch: 1, fromSeq: '1', limit: 100 }),
		).resolves.toMatchObject({ ok: true, nextSeq: '1' })

		const events: unknown[] = []
		const subscription = await client.logs.follow({ streamId: 'default' }, (event) => {
			events.push(event)
		})
		expect(events).toEqual([
			{
				type: 'gap',
				streamId: 'default',
				epoch: 1,
				missingFrom: '1',
				missingTo: '4',
			},
		])
		subscription[Symbol.dispose]()
		expect(subscriptionDispose).toHaveBeenCalledOnce()
		expect(target.describeDto).toHaveBeenCalledOnce()
		expect(target.followLogs).toHaveBeenCalledOnce()
	})
})

it('validates update snapshots received over the borrowed Management capability and disposes the subscription', async () => {
	const dispose = vi.fn()
	const snapshot = {
		sequence: 1,
		state: 'settled',
		phase: 'evaluate',
		outcome: 'retained-previous',
		durationMs: 3,
		trigger: 'entry.ts',
		error: { message: 'Missing import', file: 'new.ts', importChain: ['entry.ts', 'new.ts'] },
	}
	const target = {
		runtimeUpdateDto: async () => snapshot,
		followRuntimeUpdates: async (observer: (value: unknown) => Promise<void>) => {
			await observer(snapshot)
			return { [Symbol.dispose]: dispose }
		},
	} as unknown as RpcStub<RuntimeManagementTarget>
	const client = createRuntimeManagementClient(target)
	const events: unknown[] = []
	expect(await client.updates.snapshot()).toEqual(snapshot)
	const subscription = await client.updates.follow((value) => {
		events.push(value)
	})
	expect(events).toEqual([snapshot])
	subscription[Symbol.dispose]()
	expect(dispose).toHaveBeenCalledOnce()
	snapshot.state = 'updating'
	await expect(client.updates.snapshot()).rejects.toThrow(/state\/outcome/)
})

it('reads a real local RPC result and releases its envelope without retaining transport fields', async () => {
	class CatalogTarget extends RpcTarget {
		pluginCatalogDto() {
			return {
				plugins: [] as unknown[],
				sections: [] as unknown[],
				summary: { total: 0, running: 0, stopped: 0, autoStart: 0 },
			}
		}
		runtimeUpdateDto(): ReturnType<RuntimeManagementTarget['runtimeUpdateDto']> {
			return {
				sequence: 1,
				state: 'settled',
				phase: 'evaluate',
				outcome: 'retained-previous',
				durationMs: 3,
				trigger: 'entry.ts',
				error: null,
			}
		}
	}
	using target = new RpcStub(new CatalogTarget())
	const client = createRuntimeManagementClient(
		target as unknown as RpcStub<RuntimeManagementTarget>,
	)
	const result = await client.catalog.snapshot()
	expect(result.summary.total).toBe(0)
	expect(Object.isFrozen(result.summary)).toBe(true)
	expect(Object.getOwnPropertySymbols(result)).toEqual([])
	await expect(client.updates.snapshot()).resolves.toMatchObject({ sequence: 1, state: 'settled' })
})

it('releases result envelopes after validation success or failure without invoking payload getters', async () => {
	const dispose = vi.fn()
	const getter = vi.fn(() => [])
	const result = {
		plugins: [] as unknown[],
		sections: [] as unknown[],
		summary: { total: 0, running: 0, stopped: 0, autoStart: 0 },
		[Symbol.dispose]: dispose,
	}
	const target = {
		pluginCatalogDto: async () => result,
	} as unknown as RpcStub<RuntimeManagementTarget>
	const client = createRuntimeManagementClient(target)
	await expect(client.catalog.snapshot()).resolves.toMatchObject({ plugins: [] })
	expect(dispose).toHaveBeenCalledTimes(1)
	Object.defineProperty(result, Symbol.dispose, { value: dispose, configurable: true })
	Object.defineProperty(result, 'plugins', { enumerable: true, get: getter })
	await expect(client.catalog.snapshot()).rejects.toThrow(/data property/)
	expect(getter).not.toHaveBeenCalled()
	expect(dispose).toHaveBeenCalledTimes(2)
	Object.defineProperty(result, Symbol.dispose, { value: dispose, configurable: false })
	await expect(client.catalog.snapshot()).rejects.toThrow(/disposer must be configurable/)
	expect(dispose).toHaveBeenCalledTimes(3)
	expect(getter).not.toHaveBeenCalled()
})
