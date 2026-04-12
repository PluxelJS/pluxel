import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { defineOp, typebox } from '@pluxel/ops'
import { EffectsService } from '@pluxel/core/services'

import { Context } from '@pluxel/runtime'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'
import { ensureRuntimeOpsRegistered } from '../../src/api/ops'

function createPluginContext(root: Context, id: string): Context {
	const ctx = root.isolate([EffectsService], { name: id }) as Context
	;(ctx as any).pluginInfo = { id }
	return ctx
}

function createRuntimeHarness() {
	const root = new Context({ name: 'root' }) as Context
	const state = attachRuntimeStubs(root)
	ensureRuntimeOpsRegistered(root)
	const rpc = new RuntimeRpcApi(root as any)
	return { root, state, rpc }
}

function attachRuntimeStubs(root: Context) {
	class Alpha {}

	const namesByCtor = new Map<any, string>([[Alpha, 'Alpha']])
	const ctorsByName = new Map<string, any>([['Alpha', Alpha]])
	const running = new Set<string>()
	const enabled = new Set<string>()
	const rawConfig = new Map<string, Record<string, unknown>>()
	const extra = new Map<string, unknown>()
	const schemaMap = {
		basic: v.object({
			enabled: v.optional(v.boolean(), false),
		}),
	}

	const configService = {
		isReady: true,
		ready: Promise.resolve(),
		isEnabledInConfig(name: string) {
			return enabled.has(name)
		},
		enableInConfig(...names: string[]) {
			for (const name of names) enabled.add(name)
		},
		disableInConfig(...names: string[]) {
			for (const name of names) enabled.delete(name)
		},
		getRawConfig(name: string) {
			return rawConfig.get(name) ?? {}
		},
		patchConfig(name: string, patch: Record<string, unknown>) {
			rawConfig.set(name, { ...rawConfig.get(name), ...patch })
		},
		unsetConfigKeys(name: string, keys: string[]) {
			const next = { ...rawConfig.get(name) }
			for (const key of keys) delete next[key]
			rawConfig.set(name, next)
		},
		async ensureValidated(name: string) {
			return rawConfig.get(name) ?? {}
		},
		getExtra(key: string) {
			return extra.get(key)
		},
		setExtra(key: string, value: unknown) {
			extra.set(key, value)
		},
	}

	const loader = {
		api: {
			runtime: {
				resolve(name: string) {
					return ctorsByName.get(name)
				},
				isRunning(ctor: any) {
					return running.has(namesByCtor.get(ctor) ?? '')
				},
			},
			deps: {
				list() {
					return [{ name: 'Beta' }]
				},
			},
			registry: {
				listRegistered() {
					return ctorsByName
				},
				getCtor(name: string) {
					return ctorsByName.get(name)
				},
				findModuleId() {
					return null
				},
				getSchema(name: string) {
					return name === 'Alpha' ? schemaMap : undefined
				},
				getSchemaSource(name: string) {
					return name === 'Alpha' ? { basic: 'v.object({ enabled: v.boolean() })' } : undefined
				},
				getConfigLayout() {
					return null
				},
			},
			control: {
				async enable(name: string) {
					enabled.add(name)
					running.add(name)
				},
				deactivate(name: string, _ctor: unknown, options?: { runtimeOnly?: boolean }) {
					running.delete(name)
					if (!options?.runtimeOnly) enabled.delete(name)
				},
				enablePersisted(name: string) {
					enabled.add(name)
					running.add(name)
				},
			},
		},
	}

	const registry = {
		async commit() {
			return { ok: true as const }
		},
		listForks() {
			return []
		},
	}

	Object.defineProperty(root, 'loader', { value: loader, configurable: true })
	Object.defineProperty(root, 'configService', { value: configService, configurable: true })
	Object.defineProperty(root, 'registry', { value: registry, configurable: true })
	Object.defineProperty(root, 'packageService', { value: undefined, configurable: true })

	return { Alpha, running, enabled, rawConfig, extra }
}

describe('runtime ops', () => {
	it('restores missing runtime ops without registering transport façade ops', () => {
		const { root } = createRuntimeHarness()

		expect(root.ops.has('plugin.status')).toBe(true)
		expect(root.ops.has('runtime.ops.invoke')).toBe(false)
		expect(root.ops.has('runtime.ops.dispatch')).toBe(false)
		root.ops.unregister('plugin.status')

		ensureRuntimeOpsRegistered(root)
		expect(root.ops.has('plugin.status')).toBe(true)
	})

	it('routes CLI and RPC through the same runtime ops surface', async () => {
		const { root, state, rpc } = createRuntimeHarness()

		expect(root.ops.helpCommand('plugin start')).toEqual(
			expect.objectContaining({ id: 'plugin.start' }),
		)

		await expect(root.ops.dispatch('plugin start --name Alpha')).resolves.toEqual({
			ok: true,
			name: 'Alpha',
		})
		expect(state.running.has('Alpha')).toBe(true)

		await expect(
			rpc.opsInvoke('plugins.status.apply', {
				actions: [{ name: 'Alpha', action: 'stop' }],
			}),
		).resolves.toEqual({
			ok: true,
			results: [
				expect.objectContaining({
					name: 'Alpha',
					ok: true,
				}),
			],
		})
		expect(state.running.has('Alpha')).toBe(false)

		await expect(
			rpc.opsInvoke('plugins.status.apply', {
				actions: [{ name: 'Alpha', action: 'start' }],
			}),
		).resolves.toEqual({
			ok: true,
			results: [
				expect.objectContaining({
					name: 'Alpha',
					ok: true,
				}),
			],
		})
		expect(state.running.has('Alpha')).toBe(true)
	})

	it('supports config reads and writes through runtime ops only', async () => {
		const { state, rpc } = createRuntimeHarness()
		await expect(
			rpc.opsInvoke('plugins.config.set', {
				entries: [{ name: 'Alpha', patch: { basic: { enabled: true } } }],
			}),
		).resolves.toEqual({
			ok: true,
			items: [
				expect.objectContaining({
					name: 'Alpha',
					result: expect.objectContaining({
						ok: true,
						saved: true,
					}),
				}),
			],
		})

		expect(state.rawConfig.get('Alpha')).toEqual({ basic: { enabled: true } })

		await expect(
			rpc.opsInvoke('plugin.config.patch', {
				name: 'Alpha',
				patch: { basic: { enabled: false } },
			}),
		).resolves.toEqual(
			expect.objectContaining({
				ok: true,
				saved: true,
				config: { basic: { enabled: false } },
			}),
		)

		await expect(rpc.opsInvoke('plugin.config.get', { name: 'Alpha' })).resolves.toEqual({
			ok: true,
			saved: false,
			config: { basic: { enabled: false } },
			defaults: { basic: { enabled: false } },
		})
	})

	it('exposes plugin detail and dependency inspection through runtime ops', async () => {
		const { rpc } = createRuntimeHarness()

		await expect(rpc.opsInvoke('plugin.dependencies.list', { name: 'Alpha' })).resolves.toEqual([
			{ name: 'Beta' },
		])

		await expect(rpc.opsInvoke('plugin.dependencies.inspect', { name: 'Alpha' })).resolves.toEqual([])
	})

	it('blocks rpc invocation for ops that are not rpc-exposed', async () => {
		const { root, rpc } = createRuntimeHarness()

		root.ops.register(
			defineOp({
				id: 'demo.tool-only',
				doc: {
					title: 'Demo Tool Only',
					description: 'Tool-visible only.',
				},
				input: typebox.obj({}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
				}),
				tool: true,
				async execute() {
					return { ok: true }
				},
			}),
			{ owner: 'runtime:test' },
		)

		await expect(rpc.opsInvoke('demo.tool-only', {})).rejects.toMatchObject({
			code: 'E_FORBIDDEN',
		})
	})

	it('exposes rpc-visible ops through the catalog with owner metadata', () => {
		const { root, rpc } = createRuntimeHarness()

		const pluginCtx = createPluginContext(root, 'plugin.catalog')
		pluginCtx.ops.register(
			defineOp({
				id: 'catalog.inspect',
				doc: {
					title: 'Catalog Inspect',
					description: 'Inspect the runtime catalog',
				},
				input: typebox.obj({}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
				}),
				exposure: {
					rpc: true,
				},
				async execute() {
					return { ok: true }
				},
			}),
		)

		root.ops.register(
			defineOp({
				id: 'catalog.tool-only',
				doc: {
					title: 'Catalog Tool Only',
					description: 'Should stay out of rpc catalog.',
				},
				input: typebox.obj({}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
				}),
				tool: true,
				async execute() {
					return { ok: true }
				},
			}),
			{ owner: 'runtime:test' },
		)

		const catalog = rpc.opsCatalog()
		const pluginEntry = catalog.find((entry) => entry.id === 'catalog.inspect')

		expect(pluginEntry).toMatchObject({
			id: 'catalog.inspect',
			owner: 'plugin:plugin.catalog',
			ownerKind: 'plugin',
			pluginId: 'plugin.catalog',
		})
		expect(catalog.some((entry) => entry.id === 'catalog.tool-only')).toBe(false)
		expect(catalog.some((entry) => entry.id === 'plugin.status' && entry.ownerKind === 'runtime')).toBe(
			true,
		)
	})

	it('persists and resolves host-owned ops toolsets through rpc', async () => {
		const { state, rpc } = createRuntimeHarness()
		const expectedToolset = {
			__typename: 'OpsToolset' as const,
			toolsetId: 'daily',
			name: 'Daily Toolset',
			description: 'Use for routine runtime inspection and mutation.',
			opIds: ['plugin.status', 'plugins.status.apply'],
		}

		expect(rpc.opsToolsets()).toEqual([])

		await expect(
			rpc.updateOpsToolsets([
				{
					toolsetId: 'daily',
					name: 'Daily Toolset',
					description: 'Use for routine runtime inspection and mutation.',
					opIds: ['plugin.status', 'plugin.status', 'plugins.status.apply'],
				},
			]),
		).resolves.toEqual([expectedToolset])

		expect(state.extra.get('opsToolsets')).toEqual([
			{
				toolsetId: 'daily',
				name: 'Daily Toolset',
				description: 'Use for routine runtime inspection and mutation.',
				opIds: ['plugin.status', 'plugins.status.apply'],
			},
		])
		expect(rpc.opsToolsets()).toEqual([expectedToolset])

		expect(rpc.resolveOpsToolset('daily')).toEqual({
			toolset: expectedToolset,
			tools: expect.arrayContaining([
				expect.objectContaining({
					id: 'plugin.status',
					mutating: false,
				}),
				expect.objectContaining({
					id: 'plugins.status.apply',
					mutating: true,
				}),
			]),
			missingOpIds: [],
		})
	})
})
