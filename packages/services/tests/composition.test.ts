import { defineCommand } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { Commands, commands } from '../src/commands'
import { BasePlugin, Plugin, pluginDefinitionAddressOf } from '@pluxel/core'
import { defineContextCapability, installOwnerViewCapability } from '@pluxel/core/host'
import { createHost, defineHostService } from '@pluxel/host'
import { describe, expect, it } from 'vitest'
import { createMemoryPersistenceBackend, persistence } from '../src/persistence'
import { Vault, vault } from '../src/vault'

const Search = defineContextCapability<{ query(): string }>('example.search')
const observations: string[] = []

@Plugin()
class Credentials extends BasePlugin {
	async init() {
		const storage = this.ctx.require(Vault).kv()
		await storage.set('credential', 'secret')
		observations.push((await storage.get<string>('credential')) ?? '')
	}
}
@Plugin()
class SearchConsumer extends BasePlugin {
	init() {
		observations.push(this.ctx.require(Search).query())
	}
}
const node = (plugin: typeof Credentials | typeof SearchConsumer) => ({
	definition: pluginDefinitionAddressOf(plugin),
	variant: 'default' as const,
})

describe('independently composed official and external services', () => {
	it('prepares Vault with explicit persistence, isolates missing service failure, and flushes at close', async () => {
		observations.length = 0
		const backend = createMemoryPersistenceBackend()
		const events: string[] = []
		const search = defineHostService({
			name: 'Example Search',
			capabilities: [
				installOwnerViewCapability(Search, {
					createRoot: () => ({}),
					createView: (_root, owner) => ({ query: () => owner.pluginInfo!.displayName }),
				}),
			],
			prepare({ effects }) {
				effects.defer(() => {
					events.push('search closed')
				})
			},
		})
		const storage = persistence({ mode: 'custom', backend })
		const plugins = [Credentials, SearchConsumer]
		const first = await createHost({
			plugins,
			services: [vault({ flushDebounceMs: 60_000 }), search, storage],
		})
		try {
			expect('database' in first.ctx).toBe(false)
			await first.startNode(node(Credentials))
			await first.startNode(node(SearchConsumer))
			expect(observations).toEqual(['secret', 'SearchConsumer'])
		} finally {
			await first.close()
		}
		expect(events).toEqual(['search closed'])
		// Reopen the same encrypted storage after shutdown, before any debounce could have run.
		const reopened = await createHost({ plugins: [], services: [storage, vault()] })
		try {
			const state = await reopened.ctx.vaultAdmin!.describe()
			expect(state).toMatchObject({ present: true, unlocked: true })
			expect(state.namespaces?.some((namespace) => namespace.kvKeys === 1)).toBe(true)
		} finally {
			await reopened.close()
		}

		const second = await createHost({ plugins, services: [storage, search] })
		try {
			expect(second.ctx.vault).toBeUndefined()
			expect(() => second.ctx.require(Vault)).toThrowError(/vault/)
			await second.startNode(node(Credentials))
			await second.startNode(node(SearchConsumer))
			expect(observations).toEqual(['secret', 'SearchConsumer', 'SearchConsumer'])
		} finally {
			await second.close()
		}
	})
})

it('installs an empty command catalog and withdraws Plugin-owned registrations on stop', async () => {
	const host = await createHost({ plugins: [CommandPublisher], services: [commands()] })
	try {
		const catalog = host.ctx.require(Commands)
		expect(catalog.list()).toEqual([])
		const address = {
			definition: pluginDefinitionAddressOf(CommandPublisher),
			variant: 'default' as const,
		}
		await host.startNode(address)
		expect(catalog.list().map((item) => item.name)).toEqual(['example.read'])
		await expect(catalog.execute('example.read', {})).resolves.toEqual({ value: 'ready' })
		await host.stopNode(address)
		expect(catalog.list()).toEqual([])
		await expect(catalog.execute('example.read', {})).rejects.toThrow(/example.read/)
	} finally {
		await host.close()
	}
})

@Plugin()
class CommandPublisher extends BasePlugin {
	init() {
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'example.read',
				description: 'Read a fixture value',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({}),
				output: obj({ value: Type.String() }),
				execute: () => ({ value: 'ready' }),
			}),
		)
	}
}
