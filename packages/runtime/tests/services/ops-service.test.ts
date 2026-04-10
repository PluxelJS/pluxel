import { describe, expect, it } from 'vitest'
import { EffectsService } from '@pluxel/core/services'
import { Context } from '@pluxel/runtime'
import { defineOp, typebox } from '@pluxel/ops'

function createPluginContext(root: Context, id: string): Context {
	const ctx = root.isolate([EffectsService], { name: id }) as Context
	;(ctx as any).pluginInfo = { id }
	return ctx
}

describe('OpsService', () => {
	it('registers plugin operations into the shared runtime space', async () => {
		const root = new Context({ name: 'root' }) as Context
		const pluginCtx = createPluginContext(root, 'plugin.alpha')

		pluginCtx.ext.ops.register(
			defineOp({
				id: 'plugin-alpha.status.get',
				doc: {
					title: 'Get plugin status',
					description: 'Read runtime plugin status',
					usage: 'plugin-alpha status --name <string>',
				},
				input: typebox.obj({
					name: typebox.Type.String({ description: 'Plugin name to inspect.' }),
				}),
				output: typebox.obj({
					name: typebox.Type.String(),
					runtimeName: typebox.Type.String(),
					sourceKind: typebox.Type.String(),
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
			}),
		)

		expect(root.ext.ops.list({ exposure: 'tool' }).map((entry) => entry.id)).toEqual([
			'plugin-alpha.status.get',
		])
		expect(root.ext.ops.listTools()).toEqual([
			expect.objectContaining({
				id: 'plugin-alpha.status.get',
				name: 'plugin_status_get',
				title: 'Get plugin status',
				usage: 'plugin-alpha status --name <string>',
			}),
		])
		expect(root.ext.ops.helpIndex().list).toEqual([
			expect.objectContaining({ id: 'plugin-alpha.status.get', trigger: 'plugin-alpha status' }),
		])
		expect(root.ext.ops.helpCommand('plugin-alpha status')).toEqual(
			expect.objectContaining({
				id: 'plugin-alpha.status.get',
				usage: 'plugin-alpha status --name <string>',
			}),
		)

		await expect(root.ext.ops.invoke('plugin-alpha.status.get', { name: 'demo' })).resolves.toEqual({
			name: 'demo',
			runtimeName: 'root',
			sourceKind: 'runtime',
		})

		await expect(root.ext.ops.dispatch('plugin-alpha status --name demo')).resolves.toEqual({
			name: 'demo',
			runtimeName: 'root',
			sourceKind: 'cli',
		})
	})

	it('auto-unregisters plugin-owned operations on plugin dispose', async () => {
		const root = new Context({ name: 'root' }) as Context
		const pluginCtx = createPluginContext(root, 'plugin.beta')

		pluginCtx.ext.ops.register(
			defineOp({
				id: 'plugin-beta.echo',
				input: typebox.obj({
					value: typebox.Type.String(),
				}),
				output: typebox.obj({
					value: typebox.Type.String(),
				}),
				async execute(input) {
					return { value: input.value }
				},
			}),
		)

		expect(root.ext.ops.has('plugin-beta.echo')).toBe(true)

		await pluginCtx.effects.dispose()

		expect(root.ext.ops.has('plugin-beta.echo')).toBe(false)
	})

	it('rejects plugin registrations in reserved runtime namespaces', () => {
		const root = new Context({ name: 'root' }) as Context
		const pluginCtx = createPluginContext(root, 'plugin.gamma')

		expect(() =>
			pluginCtx.ext.ops.register(
				defineOp({
					id: 'plugin.status',
					doc: {
						title: 'Hijack Plugin Status',
						description: 'Should not be allowed.',
					},
					input: typebox.obj({
						name: typebox.Type.String({ description: 'Plugin name.' }),
					}),
					output: typebox.obj({
						ok: typebox.Type.Boolean(),
					}),
					tool: {
						name: 'plugin.status',
					},
					async execute() {
						return { ok: true }
					},
				}),
			),
		).toThrow(/reserved runtime namespace/i)
	})

	it('rejects plugin registrations that reuse reserved runtime CLI commands', () => {
		const root = new Context({ name: 'root' }) as Context
		const pluginCtx = createPluginContext(root, 'plugin.delta')

		expect(() =>
			pluginCtx.ext.ops.register(
				defineOp({
					id: 'plugin-delta.inspect',
					doc: {
						title: 'Inspect',
						description: 'Should not reuse runtime CLI verbs.',
						usage: 'plugin status --name <string>',
					},
					input: typebox.obj({
						name: typebox.Type.String({ description: 'Plugin name.' }),
					}),
					output: typebox.obj({
						ok: typebox.Type.Boolean(),
					}),
					cli: {
						triggers: ['plugin status'],
					},
					async execute() {
						return { ok: true }
					},
				}),
			),
		).toThrow(/reserved runtime command namespace/i)
	})
})
