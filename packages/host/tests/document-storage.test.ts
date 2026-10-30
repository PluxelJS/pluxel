import type { PluginNodeAddress, RootContext } from '@pluxel/core'
import { defineContextCapability, installRootCapability } from '@pluxel/core/host'
import { requireConfigService } from '@pluxel/core/internal'
import { SuperJSON } from 'superjson'
import { describe, expect, it } from 'vitest'
import { createHost, defineHostService } from '../src/index'
import { createDocumentStorage } from './helpers/document-storage'

const owner: PluginNodeAddress = {
	definition: {
		entry: { kind: 'package-root', packageName: '@test/host-documents' },
		exportName: 'Owner',
	},
	variant: 'default',
}

function documentService(events: string[]) {
	let closed = false
	const tracked = () => {
		const memory = createDocumentStorage()
		return {
			...memory,
			async getText(key: string) {
				if (closed) throw new Error('Document backend is closed')
				events.push(`read ${key}`)
				return memory.getText(key)
			},
			async put(key: string, value: string) {
				if (closed) throw new Error('Document backend is closed')
				await memory.put(key, value)
				events.push(`committed ${key}`)
			},
		}
	}
	const config = tracked()
	const state = tracked()
	const Documents = defineContextCapability<{ config: typeof config; state: typeof state }>(
		'host-test.documents',
		{ access: 'root' },
	)
	const service = defineHostService({
		name: 'host-test.documents',
		capabilities: [
			installRootCapability(Documents, {
				create(root) {
					events.push('constructed')
					root.effects.defer(
						() => {
							closed = true
							events.push('closed')
						},
						{ phase: 'final' },
					)
					return { config, state }
				},
			}),
		],
		prepare() {
			events.push('prepared')
		},
	})
	return { Documents, service, config, state }
}

describe('Host root document factories', () => {
	it.each([
		{ name: 'a storage object', options: { storage: createDocumentStorage() } },
		{ name: 'a missing storage factory', options: { mode: 'readonly' } },
		{
			name: 'a persistent factory in memory mode',
			options: { storage: () => createDocumentStorage(), mode: 'memory' },
		},
	])('rejects $name before service acquisition', async ({ options }) => {
		const events: string[] = []
		const { service } = documentService(events)
		await expect(
			createHost({ plugins: [], services: [service], state: options as never }),
		).rejects.toBeInstanceOf(TypeError)
		expect(events).toEqual([])
	})

	it('resolves both factories once before document IO and flushes runtime work before root final', async () => {
		const events: string[] = []
		const roots: RootContext[] = []
		const { Documents, service, config, state } = documentService(events)
		const flushingService = defineHostService({
			...service,
			prepare({ ctx, effects }) {
				events.push('prepared')
				effects.defer(async () => {
					requireConfigService(ctx).patchConfig(owner, { value: 'last config' })
					await state.put('service-document.json', 'last service write')
					events.push('runtime settled')
				})
			},
		})
		const host = await createHost({
			plugins: [],
			services: [flushingService],
			configRecords: {
				storage(root) {
					roots.push(root)
					events.push('config factory')
					return root.require(Documents).config
				},
			},
			state: {
				storage(root) {
					roots.push(root)
					events.push('state factory')
					return root.require(Documents).state
				},
			},
		})
		try {
			expect(roots).toEqual([host.ctx, host.ctx])
			expect(events.slice(0, 3)).toEqual(['config factory', 'constructed', 'state factory'])
			expect(events.indexOf('prepared')).toBeGreaterThan(events.indexOf('committed config.json'))
			expect(events.indexOf('prepared')).toBeGreaterThan(events.indexOf('committed state.json'))
			await host.start()
			await host.status()
			expect(events.filter((event) => event.endsWith('factory'))).toHaveLength(2)
		} finally {
			await host.close()
		}
		expect(SuperJSON.parse(config.documents.get('config.json')!)).toEqual({
			version: 3,
			plugins: [{ owner, config: { value: 'last config' } }],
		})
		expect(state.documents.has('state.json')).toBe(true)
		expect(state.documents.get('service-document.json')).toBe('last service write')
		expect(events.slice(-3)).toEqual(['runtime settled', 'committed config.json', 'closed'])
	})

	it.each([
		{ name: 'an absent namespace', result: (): undefined => undefined },
		{ name: 'null', result: (): null => null },
		{ name: 'an async namespace', result: () => Promise.resolve(createDocumentStorage()) },
		{ name: 'an incomplete namespace', result: () => ({ getText() {}, put() {} }) },
	])(
		'rejects $name before either store starts IO and still releases root resources',
		async ({ result }) => {
			const events: string[] = []
			const { Documents, service } = documentService(events)
			await expect(
				createHost({
					plugins: [],
					services: [service],
					configRecords: { storage: (root) => root.require(Documents).config },
					state: { storage: result as never },
				}),
			).rejects.toBeInstanceOf(TypeError)
			expect(events).toEqual(['constructed', 'closed'])
		},
	)

	it('cleans resources acquired by a throwing factory and retains its original failure', async () => {
		const events: string[] = []
		const failure = new Error('Document binding failed')
		const { Documents, service } = documentService(events)
		await expect(
			createHost({
				plugins: [],
				services: [service],
				configRecords: {
					storage(root) {
						root.require(Documents)
						throw failure
					},
				},
			}),
		).rejects.toBe(failure)
		expect(events).toEqual(['constructed', 'closed'])
	})

	it.each(['read', 'initial commit', 'service prepare'] as const)(
		'releases root resources after a failed %s',
		async (stage) => {
			const events: string[] = []
			const failure = new Error(`${stage} failed`)
			const { Documents, service, config } = documentService(events)
			if (stage === 'read')
				config.getText = async () => {
					throw failure
				}
			if (stage === 'initial commit')
				config.put = async () => {
					throw failure
				}
			const hostService = {
				...service,
				prepare() {
					if (stage === 'service prepare') throw failure
				},
			}
			await expect(
				createHost({
					plugins: [],
					services: [hostService],
					configRecords: { storage: (root) => root.require(Documents).config },
				}),
			).rejects.toBe(failure)
			expect(events.at(-1)).toBe('closed')
		},
	)

	it('waits for a store already loading when the other store constructor fails', async () => {
		const events: string[] = []
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		const { Documents, service, state } = documentService(events)
		state.getText = async () => {
			entered.resolve()
			await release.promise
			events.push('state read settled')
			return undefined
		}
		const creation = createHost({
			plugins: [],
			services: [service],
			configRecords: {
				storage: (root) => root.require(Documents).config,
				overlays: [{ owner, config: { value: 'overlay' }, sources: [] }],
			},
			state: { storage: (root) => root.require(Documents).state },
		})
		const observed = creation.catch((error: unknown) => error)
		await entered.promise
		release.resolve()
		expect(await observed).toMatchObject({
			message: '[host] every environment overlay value requires source metadata',
		})
		expect(events.indexOf('closed')).toBeGreaterThan(events.indexOf('state read settled'))
		expect(events.indexOf('closed')).toBeGreaterThan(events.indexOf('committed state.json'))
	})

	it('retains the preparation cause and runs final cleanup after another cleanup fails', async () => {
		const events: string[] = []
		const failure = new Error('Document read failed')
		const cleanupFailure = new Error('Runtime cleanup failed')
		const { Documents, service, config } = documentService(events)
		config.getText = async () => {
			throw failure
		}
		await expect(
			createHost({
				plugins: [],
				services: [service],
				configRecords: {
					storage(root) {
						root.effects.defer(() => {
							throw cleanupFailure
						})
						return root.require(Documents).config
					},
				},
			}),
		).rejects.toMatchObject({
			cause: failure,
			errors: [failure, expect.objectContaining({ errors: [cleanupFailure] })],
		})
		expect(events.at(-1)).toBe('closed')
	})

	it('rejects access to Host config while document factories are being resolved', async () => {
		const events: string[] = []
		const { Documents, service } = documentService(events)
		await expect(
			createHost({
				plugins: [],
				services: [service],
				configRecords: { storage: (root) => root.require(Documents).config },
				state: {
					storage(root) {
						requireConfigService(root)
						return root.require(Documents).state
					},
				},
			}),
		).rejects.toThrow('document storage factories must not read Host config')
		expect(events).toEqual(['constructed', 'closed'])
	})
})
