import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { defineOp, typebox } from '@pluxel/ops'

import { Context } from '@pluxel/runtime'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'
import { ensureRuntimeOpsRegistered } from '../../src/api/ops'

function attachRuntimeStubs(root: Context) {
	class Alpha {}

	const namesByCtor = new Map<any, string>([[Alpha, 'Alpha']])
	const ctorsByName = new Map<string, any>([['Alpha', Alpha]])
	const running = new Set<string>()
	const enabled = new Set<string>()
	const rawConfig = new Map<string, Record<string, unknown>>()
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
		getExtra() {
			return undefined
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

	return { Alpha, running, enabled, rawConfig }
}

describe('runtime ops', () => {
	it('re-registers missing runtime ops when ensured again', () => {
		const root = new Context({ name: 'root' }) as Context
		attachRuntimeStubs(root)
		ensureRuntimeOpsRegistered(root)

		expect(root.ext.ops.has('plugin.status')).toBe(true)
		expect(root.ext.ops.has('runtime.ops.list')).toBe(true)
		expect(root.ext.ops.has('runtime.ops.invoke')).toBe(false)
		expect(root.ext.ops.has('runtime.ops.dispatch')).toBe(false)
		root.ext.ops.unregister('plugin.status')
		expect(root.ext.ops.has('plugin.status')).toBe(false)

		ensureRuntimeOpsRegistered(root)
		expect(root.ext.ops.has('plugin.status')).toBe(true)
	})

	it('routes CLI and RPC through the same runtime ops surface', async () => {
		const root = new Context({ name: 'root' }) as Context
		const state = attachRuntimeStubs(root)
		ensureRuntimeOpsRegistered(root)

		expect(root.ext.ops.has('plugins.status.apply')).toBe(true)
		expect(root.ext.ops.helpCommand('plugin start')).toEqual(
			expect.objectContaining({ id: 'plugin.start' }),
		)

		await expect(root.ext.ops.dispatch('plugin start --name Alpha')).resolves.toEqual({
			ok: true,
			name: 'Alpha',
		})
		expect(state.running.has('Alpha')).toBe(true)

		const rpc = new RuntimeRpcApi(root as any)
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
		const root = new Context({ name: 'root' }) as Context
		const state = attachRuntimeStubs(root)
		ensureRuntimeOpsRegistered(root)

		const rpc = new RuntimeRpcApi(root as any)
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
		const root = new Context({ name: 'root' }) as Context
		attachRuntimeStubs(root)
		ensureRuntimeOpsRegistered(root)

		const rpc = new RuntimeRpcApi(root as any)

		await expect(rpc.opsInvoke('plugin.dependencies.list', { name: 'Alpha' })).resolves.toEqual([
			{ name: 'Beta' },
		])

		await expect(rpc.opsInvoke('plugin.dependencies.inspect', { name: 'Alpha' })).resolves.toEqual([])
	})

	it('blocks rpc invocation for ops that are not rpc-exposed', async () => {
		const root = new Context({ name: 'root' }) as Context
		attachRuntimeStubs(root)
		ensureRuntimeOpsRegistered(root)

		root.ext.ops.register(
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

		const rpc = new RuntimeRpcApi(root as any)
		await expect(rpc.opsInvoke('demo.tool-only', {})).rejects.toMatchObject({
			code: 'E_FORBIDDEN',
		})
	})
})
