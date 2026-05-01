// Read this when:
// - 你要给插件注册 ops
// - 你想看 `defineOp(...)` + `ctx.ops.register(...)` 的最小独立样板

import { cli, defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin({ name: 'PluginOpsDemo' })
export class PluginOpsDemo extends BasePlugin {
	private startedAt = Date.now()
	private counter = 0
	private lastNote: string | null = null

	override init(): void {
		this.startedAt = Date.now()
		this.registerOps()
	}

	private registerOps() {
		this.ctx.ops.register(
			defineOp({
				id: 'plugin-ops-demo.status.get',
				doc: {
					title: 'Get PluginOpsDemo Status',
					description: 'Read the in-memory status exposed by the standalone ops demo.',
				},
				input: obj({}),
				output: obj({
					pluginName: Type.String(),
					startedAt: Type.Number(),
					counter: Type.Number(),
					lastNote: Type.Union([Type.String(), Type.Null()]),
				}),
				run: async () => ({
					pluginName: this.ctx.pluginInfo.id,
					startedAt: this.startedAt,
					counter: this.counter,
					lastNote: this.lastNote,
				}),
				}),
				{
					metadata: {
						rpc: true,
						cli: { triggers: ['plugin-ops-demo status'] },
					},
				},
			)

		this.ctx.ops.register(
			defineOp({
				id: 'plugin-ops-demo.counter.bump',
				doc: {
					title: 'Bump PluginOpsDemo Counter',
					description: 'Increment the standalone ops demo counter.',
				},
				input: obj({
					delta: Type.Optional(
						Type.Number({
							description: 'Counter increment. Defaults to 1.',
						}),
					),
				}),
				output: obj({
					counter: Type.Number(),
				}),
				run: async (input) => {
					this.counter += this.normalizeDelta(input.delta)
					return { counter: this.counter }
				},
				}),
				{
					metadata: {
						rpc: true,
						workbench: { mutating: true },
						cli: { triggers: ['plugin-ops-demo counter bump'] },
					},
				},
			)

		this.ctx.ops.register(
			defineOp({
				id: 'plugin-ops-demo.note.set',
				doc: {
					title: 'Set PluginOpsDemo Note',
					description: 'Store a short in-memory note through an MCP-facing op.',
				},
				input: obj({
					message: Type.String({
						minLength: 1,
						description: 'Note text to store in the demo plugin.',
					}),
				}),
				output: obj({
					message: Type.String(),
				}),
				run: async (input) => {
					const message = input.message.trim()
					if (!message) throw new Error('message must not be blank')
					this.lastNote = message
					return { message: this.lastNote }
				},
				}),
				{
					metadata: {
						mcp: { name: 'plugin-ops-demo.note.set' },
						workbench: { mutating: true },
						cli: {
							triggers: ['plugin-ops-demo note set'],
							tail: cli.tail.line('message'),
						},
					},
				},
			)
	}

	private normalizeDelta(value: number | undefined) {
		const normalized = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 1
		return normalized === 0 ? 1 : normalized
	}
}
