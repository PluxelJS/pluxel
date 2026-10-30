import { servicesPreset } from '@pluxel/services/preset'
import { createElysiaHandler } from '@pluxel/services/elysia'
import { ElysiaRuntime } from '@pluxel/services/internal'
import { defineCommand, Result } from '@pluxel/commands'
import { obj } from '@pluxel/commands/typebox'
import { Commands, commands } from '../src/commands'
import { BasePlugin, Plugin, pluginDefinitionAddressOf } from '@pluxel/core'
import {
	defineContextCapability,
	installOwnerViewCapability,
	resolveContextCapability,
} from '@pluxel/core/host'
import { createHost, defineHostService } from '@pluxel/host'
import { Logging } from '@pluxel/services/logging'
import { Management } from '@pluxel/services/management/service'
import { parseVaultAdminState } from '@pluxel/services/management/internal/test'
import { afterEach, describe, expect, it } from 'vitest'
import * as nativeFs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fs, InMemory, Passthrough } from '../src/fs'
import { Vault, VaultAdmin, vault } from '../src/vault'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const Search = defineContextCapability<{ query(): string }>('example.search')
const observations: string[] = []

@Plugin()
class Credentials extends BasePlugin {
	async init() {
		const storage = this.ctx.require(Vault).kv()
		await storage.set('credential', 'secret')
		observations.push(
			(await storage.get<string>('credential').then((snapshot) => snapshot.value)) ?? '',
		)
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
	it.each([false, true])(
		'keeps Management HTTP independent of Workbench selection (%s)',
		async (workbench) => {
			const services = await servicesPreset(
				{ root: process.cwd(), mode: 'development', env: {}, bindings: {} },
				{
					fs: { backend: InMemory },
					workbench,
				},
			)
			// Preparation order follows declared capabilities, not the preset's array order.
			const host = await createHost({ plugins: [], services: services.toReversed() })
			const logging = resolveContextCapability(host.ctx, Logging)
			try {
				expect(logging.state).toBe('installed')
				expect(resolveContextCapability(host.ctx, Management)).toBeDefined()
				const vaultState = await resolveContextCapability(host.ctx, VaultAdmin).describe()
				expect(parseVaultAdminState(vaultState)).toEqual(vaultState)
				await host.start()
				const server = host.ctx.require(ElysiaRuntime)
				const missing = new Request('http://local.dev/missing')
				expect(server.matchesRequest(missing)).toBe(false)
				const missingResponse = await createElysiaHandler(host)(missing)
				expect(missingResponse.status).toBe(404)
				const request = new Request('http://local.dev/__pluxel/runtime/session', {
					headers: { upgrade: 'websocket', connection: 'Upgrade' },
				})
				expect(server.matchesRequest(request)).toBe(true)
				expect(server.matchesWebSocketRoute(request)).toBe(true)
				const handshake = await server.fetch(new Request(request.url))
				expect(handshake.status).toBe(400)
				expect('workbench' in host.ctx).toBe(workbench)
				const page = new Request('http://local.dev/__pluxel/workbench', {
					headers: { accept: 'text/html' },
				})
				expect(server.matchesRequest(page)).toBe(workbench)
				const headlessResponse = workbench ? undefined : await server.fetch(page)
				expect(headlessResponse?.status).toBe(workbench ? undefined : 404)
			} finally {
				await host.close()
			}
			expect(logging.state).toBe('disposed')
		},
		30_000,
	)

	it('prepares Vault with explicit persistence, isolates missing service failure, and flushes at close', async () => {
		observations.length = 0
		const prefix = await mkdtemp(join(tmpdir(), 'pluxel-composition-'))
		directories.push(prefix)
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
		const storage = fs({ backend: Passthrough, fs: nativeFs, prefix })
		const plugins = [Credentials, SearchConsumer]
		const first = await createHost({
			plugins,
			services: [vault(), search, storage],
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
		await expect(catalog.execute('example.read', {})).resolves.toEqual(
			Result.ok({ value: 'ready' }),
		)
		await host.stopNode(address)
		expect(catalog.list()).toEqual([])
		await expect(catalog.execute('example.read', {})).resolves.toMatchObject({
			status: 'error',
			error: { code: 'COMMAND_NOT_FOUND' },
		})
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
				input: obj({}),
				execute: () => Result.ok({ value: 'ready' }),
			}),
		)
	}
}
