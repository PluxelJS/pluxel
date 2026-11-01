import { requireConfigService } from '@pluxel/core/internal'
import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
import { SuperJSON } from 'superjson'
import { expect, it } from 'vitest'
import { createHost, type HostConfigSyncOptions } from '../src/index'
import { acceptReplicatedConfig } from '../src/config'
import type { HostConfigStore } from '../src/config-store'
import { createConfigSyncSnapshot, decodeConfigSyncSnapshot } from '../src/config-sync-protocol'
import { createDocumentStorage } from './helpers/document-storage'

const artifact = { name: '@fixture/config-sync-admission', catalogHash: 'a'.repeat(64) }
const writer = {
	role: 'writer',
	scope: 'regression',
	artifact,
	identity: 'writer',
	replicas: [],
} as const satisfies HostConfigSyncOptions
const replica = {
	role: 'replica',
	scope: 'regression',
	artifact,
	identity: 'replica',
	writer: 'writer',
	url: 'http://127.0.0.1:1/config',
	token: 'config-regression-secret',
} as const satisfies HostConfigSyncOptions
const missing = {
	definition: {
		entry: { kind: 'package-root' as const, packageName: '@fixture/not-installed' },
		exportName: 'Missing',
	},
	variant: 'default' as const,
}

it('rejects an unmergeable unknown owner before replacing the durable saved document', async () => {
	const storage = createDocumentStorage()
	const initial = createConfigSyncSnapshot(writer, [], { history: 'cycle', seq: 0 })
	const originalText = SuperJSON.stringify(initial)
	await storage.put('config.json', originalText)
	const host = await createHost({
		plugins: [],
		configRecords: { storage: () => storage },
		configSync: replica,
	})
	try {
		const config: Record<string, unknown> = {}
		config.self = config
		const records: PluginConfigRecordSnapshot[] = [
			{
				owner: missing,
				config,
			},
		]
		expect(() => createConfigSyncSnapshot(writer, records, { history: 'cycle', seq: 1 })).toThrow(
			'must be acyclic',
		)
		const candidate = {
			...initial,
			seq: 1,
			body: SuperJSON.stringify({ version: 3, plugins: records }),
		}
		expect(() => decodeConfigSyncSnapshot(candidate, replica)).toThrow('must be acyclic')
		await expect(
			acceptReplicatedConfig(host.ctx, candidate, records, {
				catalog: () => host.catalog(),
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('must be acyclic')
		expect(await storage.getText('config.json')).toBe(originalText)
		expect((requireConfigService(host.ctx) as HostConfigStore).snapshot).toEqual(initial)
	} finally {
		await host.close()
	}
})

it('bounds recursive saved-layer expansion while retaining SuperJSON leaves and acyclic shared values', () => {
	const cyclicArray: unknown[] = []
	cyclicArray.push(cyclicArray)
	expect(() =>
		createConfigSyncSnapshot(writer, [{ owner: missing, config: { values: cyclicArray } }], {
			history: 'budget',
			seq: 1,
		}),
	).toThrow('must be acyclic')
	let deep: Record<string, unknown> = {}
	for (let depth = 0; depth < 130; depth++) deep = { nested: deep }
	expect(() =>
		createConfigSyncSnapshot(writer, [{ owner: missing, config: deep }], {
			history: 'budget',
			seq: 1,
		}),
	).toThrow('exceeds the merge budget')
	expect(() =>
		createConfigSyncSnapshot(
			writer,
			[{ owner: missing, config: { values: Array.from({ length: 100_000 }, () => 0) } }],
			{ history: 'budget', seq: 1 },
		),
	).toThrow('exceeds the merge budget')
	const shared: { at: Date; optional: undefined } = {
		at: new Date('2026-11-01T00:00:00Z'),
		optional: undefined,
	}
	const candidate = createConfigSyncSnapshot(
		writer,
		[{ owner: missing, config: { left: shared, right: shared } }],
		{ history: 'budget', seq: 1 },
	)
	const decoded = decodeConfigSyncSnapshot(candidate, replica)
	expect(decoded.records[0]!.config).toEqual({ left: shared, right: shared })
	expect(decoded.snapshot.body).toBe(candidate.body)
})
