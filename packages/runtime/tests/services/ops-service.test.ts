import { describe, expect, it } from 'vitest'
import { EffectsService } from '@pluxel/core/services'
import { withRuntimeContext, type Context } from '@pluxel/runtime/test'
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
		},
		input: obj({
			name: Type.String({ description: 'Plugin name to inspect.' }),
		}),
		output: obj({
			name: Type.String(),
			runtimeName: Type.String(),
			sourceKind: Type.String(),
		}),
		async run(input, ctx) {
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
		await withRuntimeContext(async (root) => {
			const pluginCtx = createPluginContext(root, 'plugin.alpha')

			pluginCtx.ops.register(definePluginStatusOp(), {
				metadata: {
					mcp: { name: 'plugin_status_get' },
					cli: { triggers: ['plugin-alpha status'] },
				},
			})

			expect(root.ops.list({ carrier: 'mcp' }).map((entry) => entry.id)).toContain(
				'plugin-alpha.status.get',
			)
			expect(root.ops.listMcpTools()).toEqual(
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
				ok: true,
				value: {
					name: 'demo',
					runtimeName: 'test',
					sourceKind: 'runtime',
				},
			})

			await expect(root.ops.dispatch('plugin-alpha status --name demo')).resolves.toEqual({
				ok: true,
				value: {
					name: 'demo',
					runtimeName: 'test',
					sourceKind: 'cli',
				},
			})
		})
	})

	it('auto-unregisters plugin-owned operations on plugin dispose', async () => {
		await withRuntimeContext(async (root) => {
			const pluginCtx = createPluginContext(root, 'plugin.beta')

			pluginCtx.ops.register(
				defineOp({
					id: 'plugin-beta.echo',
					doc: {
						title: 'Echo',
						description: 'Echo a value.',
					},
					input: obj({
						value: Type.String(),
					}),
					output: obj({
						value: Type.String(),
					}),
					async run(input) {
						return { value: input.value }
					},
				}),
			)

			expect(root.ops.get('plugin-beta.echo')).toBeTruthy()
			expect(root.ops.listCatalog()).toEqual([
				expect.objectContaining({
					id: 'plugin-beta.echo',
					owner: 'plugin:plugin.beta',
					ownerKind: 'plugin',
					pluginId: 'plugin.beta',
				}),
			])

			await pluginCtx.effects.dispose()

			expect(root.ops.get('plugin-beta.echo')).toBeUndefined()
			expect(root.ops.listCatalog()).toEqual([])
		})
	})

	it('rolls back core registration when adapter binding fails', async () => {
		await withRuntimeContext((root) => {
			const pluginCtx = createPluginContext(root, 'plugin.rollback')
			const op = defineOp({
				id: 'plugin-rollback.scalar',
				doc: {
					title: 'Scalar CLI',
					description: 'Invalid CLI binding for scalar input.',
				},
				input: Type.String(),
				output: obj({
					ok: Type.Boolean(),
				}),
				async run() {
					return { ok: true }
				},
			})

			expect(() =>
				pluginCtx.ops.register(op, {
					metadata: { cli: { triggers: ['plugin-rollback scalar'] } },
				}),
			).toThrow(/non-object input requires an explicit tail parser/i)

			expect(root.ops.get('plugin-rollback.scalar')).toBeUndefined()
			expect(root.ops.listCatalog().map((entry) => entry.id)).not.toContain(
				'plugin-rollback.scalar',
			)
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
					async run() {
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
					},
					input: obj({
						name: Type.String({ description: 'Plugin name.' }),
					}),
					output: obj({
						ok: Type.Boolean(),
					}),
					async run() {
						return { ok: true }
					},
				}),
			error: /reserved runtime command namespace/i,
		},
	])('rejects plugin registrations that reuse $name', ({ create, error }) => {
		return withRuntimeContext((root) => {
			const pluginCtx = createPluginContext(root, 'plugin.gamma')
			const metadata =
				create().id === 'plugin-delta.inspect'
					? { cli: { triggers: ['plugin status'] } }
					: { mcp: { name: 'plugin.status' } }
			expect(() => pluginCtx.ops.register(create(), { metadata })).toThrow(error)
		})
	})
})
