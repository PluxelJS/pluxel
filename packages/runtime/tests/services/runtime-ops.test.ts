import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'
import { BasePlugin, createHost, Plugin, setParamToken, type Host } from '@pluxel/test'

import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'
import { ensureRuntimeOpsRegistered } from '../../src/api/ops'

const AlphaConfig = v.object({
	enabled: v.optional(v.boolean(), false),
})

@Plugin({ name: 'Alpha' })
class Alpha extends BasePlugin {
	basic = this.configs.use(AlphaConfig)
}

@Plugin({ name: 'Beta' })
class Beta extends BasePlugin {}

@Plugin({ name: 'Consumer' })
class Consumer extends BasePlugin {
	constructor(_beta: Beta) {
		super()
	}
}

setParamToken(Consumer, 0, Beta)

type RuntimeHarness = {
	readonly host: Host
	readonly root: Host['ctx']
	readonly rpc: RuntimeRpcApi
}

async function createRuntimeHarness(): Promise<RuntimeHarness> {
	const host = createHost()
	await host.ctx.loader.preloadPlugins(
		[
			{ plugin: Alpha, enable: false },
			{ plugin: Beta, enable: false },
			{ plugin: Consumer, enable: false },
		],
		{ commit: false },
	)
	const rpc = new RuntimeRpcApi(host.ctx)
	return { host, root: host.ctx, rpc }
}

async function withRuntimeHarness<T>(run: (harness: RuntimeHarness) => Promise<T> | T): Promise<T> {
	const harness = await createRuntimeHarness()
	try {
		return await run(harness)
	} finally {
		await harness.host.dispose()
	}
}

describe('runtime ops', () => {
	it('registers canonical runtime ops idempotently', async () => {
		await withRuntimeHarness(({ root }) => {
			expect(root.ops.get('plugin.status')).toBeTruthy()
			ensureRuntimeOpsRegistered(root)
			expect(root.ops.get('plugin.status')).toBeTruthy()
		})
	})

	it('routes CLI and RPC through the same runtime ops surface', async () => {
		await withRuntimeHarness(async ({ host, root, rpc }) => {
			expect(root.ops.helpCommand('plugin start')).toEqual(
				expect.objectContaining({ id: 'plugin.start' }),
			)

			await expect(root.ops.dispatch('plugin start --name Alpha')).resolves.toEqual({
				ok: true,
				value: {
					ok: true,
					name: 'Alpha',
				},
			})
			expect(host.isRunning(Alpha)).toBe(true)

			await expect(
				rpc.opsInvoke('plugins.status.apply', {
					actions: [{ name: 'Alpha', action: 'stop' }],
				}),
			).resolves.toEqual({
				ok: true,
				value: {
					ok: true,
					results: [
						expect.objectContaining({
							name: 'Alpha',
							ok: true,
						}),
					],
				},
			})
			expect(host.isRunning(Alpha)).toBe(false)

			await expect(
				rpc.opsInvoke('plugins.status.apply', {
					actions: [{ name: 'Alpha', action: 'start' }],
				}),
			).resolves.toEqual({
				ok: true,
				value: {
					ok: true,
					results: [
						expect.objectContaining({
							name: 'Alpha',
							ok: true,
						}),
					],
				},
			})
			expect(host.isRunning(Alpha)).toBe(true)
		})
	})

	it('supports config reads and writes through runtime ops only', async () => {
		await withRuntimeHarness(async ({ root, rpc }) => {
			await expect(
				rpc.opsInvoke('plugins.config.set', {
					entries: [{ name: 'Alpha', patch: { basic: { enabled: true } } }],
				}),
			).resolves.toEqual({
				ok: true,
				value: {
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
				},
			})

			expect(root.configService.getRawConfig('Alpha')).toEqual({ basic: { enabled: true } })

			await expect(
				rpc.opsInvoke('plugin.config.patch', {
					name: 'Alpha',
					patch: { basic: { enabled: false } },
				}),
			).resolves.toEqual(
				expect.objectContaining({
					ok: true,
					value: expect.objectContaining({
						ok: true,
						saved: true,
						config: { basic: { enabled: false } },
					}),
				}),
			)

			await expect(rpc.opsInvoke('plugin.config.get', { name: 'Alpha' })).resolves.toEqual({
				ok: true,
				value: {
					ok: true,
					saved: false,
					config: { basic: { enabled: false } },
					defaults: { basic: { enabled: false } },
				},
			})
		})
	})

	it('exposes plugin detail and dependency inspection through runtime ops', async () => {
		await withRuntimeHarness(async ({ rpc }) => {
			await expect(
				rpc.opsInvoke('plugin.dependencies.list', { name: 'Consumer' }),
			).resolves.toEqual({
				ok: true,
				value: [expect.objectContaining({ name: 'Beta' })],
			})

			await expect(
				rpc.opsInvoke('plugin.dependencies.inspect', { name: 'Consumer' }),
			).resolves.toEqual({
				ok: true,
				value: [
					expect.objectContaining({
						index: 0,
						token: 'Beta',
						kind: 'plugin',
						effective: 'Beta',
						selected: null,
					}),
				],
			})
		})
	})

	it('blocks rpc invocation for ops that have no rpc binding', async () => {
		await withRuntimeHarness(async ({ root, rpc }) => {
			root.ops.register(
				defineOp({
					id: 'demo.mcp-only',
					doc: {
						title: 'Demo MCP Only',
						description: 'MCP-visible only.',
					},
					input: obj({}),
					output: obj({
						ok: Type.Boolean(),
					}),
					async run() {
						return { ok: true }
					},
				}),
				{ owner: 'runtime:test', metadata: { rpc: false, mcp: {} } },
			)

			await expect(rpc.opsInvoke('demo.mcp-only', {})).rejects.toMatchObject({
				code: 'E_FORBIDDEN',
			})
		})
	})

	it('exposes rpc-visible ops through the catalog with owner metadata', async () => {
		await withRuntimeHarness(({ root, rpc }) => {
			const pluginCtx = root.isolate([], { name: 'plugin.catalog' })
			;(pluginCtx as any).pluginInfo = { id: 'plugin.catalog' }
			pluginCtx.ops.register(
				defineOp({
					id: 'catalog.inspect',
					doc: {
						title: 'Catalog Inspect',
						description: 'Inspect the runtime catalog',
					},
					input: obj({}),
					output: obj({
						ok: Type.Boolean(),
					}),
					async run() {
						return { ok: true }
					},
				}),
				{ metadata: { rpc: true } },
			)

			root.ops.register(
				defineOp({
					id: 'catalog.mcp-only',
					doc: {
						title: 'Catalog MCP Only',
						description: 'Should stay out of rpc catalog.',
					},
					input: obj({}),
					output: obj({
						ok: Type.Boolean(),
					}),
					async run() {
						return { ok: true }
					},
				}),
				{ owner: 'runtime:test', metadata: { rpc: false, mcp: {} } },
			)

			const catalog = rpc.opsCatalog()
			const pluginEntry = catalog.find((entry) => entry.id === 'catalog.inspect')

			expect(pluginEntry).toMatchObject({
				id: 'catalog.inspect',
				owner: 'plugin:plugin.catalog',
				ownerKind: 'plugin',
				pluginId: 'plugin.catalog',
			})
			expect(catalog.some((entry) => entry.id === 'catalog.mcp-only')).toBe(false)
			expect(
				catalog.some((entry) => entry.id === 'plugin.status' && entry.ownerKind === 'runtime'),
			).toBe(true)
		})
	})

	it('persists and resolves host-owned ops toolsets through rpc', async () => {
		await withRuntimeHarness(async ({ rpc }) => {
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

			await expect(
				rpc.updateOpsToolsets([
					{
						toolsetId: 'daily',
						name: 'Stale Daily Name',
						opIds: ['plugin.status'],
					},
					{
						toolsetId: 'daily',
						name: 'Daily Toolset',
						description: 'Deduplicated write wins by toolset id.',
						opIds: ['plugins.status.apply', 'plugins.status.apply'],
					},
					{
						toolsetId: '',
						name: 'Invalid',
						opIds: ['plugin.status'],
					},
				]),
			).resolves.toEqual([
				{
					__typename: 'OpsToolset',
					toolsetId: 'daily',
					name: 'Daily Toolset',
					description: 'Deduplicated write wins by toolset id.',
					opIds: ['plugins.status.apply'],
				},
			])
		})
	})
})
