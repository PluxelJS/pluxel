import { describe, expect, it } from 'vitest'
import { EffectsService } from '@pluxel/core/services'
import { withContext, type Context } from '@pluxel/test'
import { defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

function createPluginContext(root: Context, id: string): Context {
	const ctx = root.isolate([EffectsService], { name: id }) as Context
	;(ctx as any).pluginInfo = { id }
	return ctx
}

function definePluginStatusOp() {
	return defineOp({
		id: 'plugin-alpha.status.get',
		doc: {
			title: 'Get plugin status',
			description: 'Read runtime plugin status',
			usage: 'plugin-alpha status --name <string>',
		},
		input: obj({
			name: Type.String({ description: 'Plugin name to inspect.' }),
		}),
		output: obj({
			name: Type.String(),
			runtimeName: Type.String(),
			sourceKind: Type.String(),
		}),
		exposure: {
			rpc: true,
		},
		tool: {
			name: 'plugin_status_get',
		},
		cli: {
			triggers: ['plugin-alpha status'],
		},
		async execute(input, ctx) {
			return {
				name: input.name,
				runtimeName: ctx.runtime.name,
				sourceKind: ctx.source?.kind ?? 'unknown',
			}
		},
	})
}

describe('OpsService', () => {
	it('projects one plugin op consistently across registry, tool, help, and execution surfaces', async () => {
		await withContext(async (root) => {
			const pluginCtx = createPluginContext(root, 'plugin.alpha')

			pluginCtx.ops.register(definePluginStatusOp())

			expect(root.ops.list({ carrier: 'tool' }).map((entry) => entry.id)).toContain(
				'plugin-alpha.status.get',
			)
			expect(root.ops.listTools()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: 'plugin-alpha.status.get',
						name: 'plugin_status_get',
						title: 'Get plugin status',
					}),
				]),
			)
			expect(root.ops.helpCommand('plugin-alpha status')).toEqual(
				expect.objectContaining({
					id: 'plugin-alpha.status.get',
					usage: 'plugin-alpha status --name <string>',
				}),
			)

			await expect(root.ops.invoke('plugin-alpha.status.get', { name: 'demo' })).resolves.toEqual({
				name: 'demo',
				runtimeName: 'test',
				sourceKind: 'runtime',
			})

			await expect(root.ops.dispatch('plugin-alpha status --name demo')).resolves.toEqual({
				name: 'demo',
				runtimeName: 'test',
				sourceKind: 'cli',
			})
		})
	})

	it('auto-unregisters plugin-owned operations on plugin dispose', async () => {
		await withContext(async (root) => {
			const pluginCtx = createPluginContext(root, 'plugin.beta')

			pluginCtx.ops.register(
				defineOp({
					id: 'plugin-beta.echo',
					input: obj({
						value: Type.String(),
					}),
					output: obj({
						value: Type.String(),
					}),
					async execute(input) {
						return { value: input.value }
					},
				}),
			)

			expect(root.ops.has('plugin-beta.echo')).toBe(true)
			expect(root.ops.listCatalog()).toEqual([
				expect.objectContaining({
					id: 'plugin-beta.echo',
					owner: 'plugin:plugin.beta',
					ownerKind: 'plugin',
					pluginId: 'plugin.beta',
				}),
			])

			await pluginCtx.effects.dispose()

			expect(root.ops.has('plugin-beta.echo')).toBe(false)
			expect(root.ops.listCatalog()).toEqual([])
		})
	})

	it.each([
		{
			name: 'reserved runtime namespace',
			create: () =>
				defineOp({
					id: 'plugin.status',
					doc: {
						title: 'Hijack Plugin Status',
						description: 'Should not be allowed.',
					},
					input: obj({
						name: Type.String({ description: 'Plugin name.' }),
					}),
					output: obj({
						ok: Type.Boolean(),
					}),
					tool: {
						name: 'plugin.status',
					},
					async execute() {
						return { ok: true }
					},
				}),
			error: /reserved runtime namespace/i,
		},
		{
			name: 'reserved runtime CLI trigger',
			create: () =>
				defineOp({
					id: 'plugin-delta.inspect',
					doc: {
						title: 'Inspect',
						description: 'Should not reuse runtime CLI verbs.',
						usage: 'plugin status --name <string>',
					},
					input: obj({
						name: Type.String({ description: 'Plugin name.' }),
					}),
					output: obj({
						ok: Type.Boolean(),
					}),
					cli: {
						triggers: ['plugin status'],
					},
					async execute() {
						return { ok: true }
					},
				}),
			error: /reserved runtime command namespace/i,
		},
	])('rejects plugin registrations that reuse $name', ({ create, error }) => {
		return withContext((root) => {
			const pluginCtx = createPluginContext(root, 'plugin.gamma')
			expect(() => pluginCtx.ops.register(create())).toThrow(error)
		})
	})
})
