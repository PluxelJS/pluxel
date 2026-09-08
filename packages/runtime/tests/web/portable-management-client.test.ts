import type { RpcStub } from 'capnweb'
import { describe, expect, it, vi } from 'vitest'

import { createRuntimeManagementClient } from '../../src/web/client'
import { RUNTIME_MANAGEMENT_CAPABILITIES } from '../../src/web/protocol'
import type {
	RuntimeLogObserver,
	RuntimeSubscriptionTarget,
	RuntimeManagementTarget,
} from '../../src/web/management-target'

const metadata = Object.freeze({
	service: 'pluxel-runtime' as const,
	ready: true as const,
	protocol: Object.freeze({
		name: 'pluxel.management' as const,
		major: 6 as const,
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
			describe: vi.fn(async () => metadata),
			pluginCatalog: vi.fn(async () => ({
				plugins: [],
				sections: [],
				summary: { total: 0, running: 0, stopped: 0, autoStart: 0 },
			})),
			updatePluginCatalogLayout: vi.fn(async () => ({ ok: true, sections: [] })),
			logStreams: vi.fn(async () => ({ streams: [logMeta] })),
			logMeta: vi.fn(async () => logMeta),
			logRange: vi.fn(async () => ({
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
				return { [Symbol.dispose]: subscriptionDispose } as RuntimeSubscriptionTarget
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
		expect(target.updatePluginCatalogLayout).toHaveBeenLastCalledWith({ sections: null })
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
		expect(target.describe).toHaveBeenCalledOnce()
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
		runtimeUpdate: async () => snapshot,
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
