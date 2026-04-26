// Read this when:
// - 你要给插件注册 ops
// - 你想看 `defineOp(...)` + `ctx.ops.register(...)` 的最小独立样板

import { defineOp } from '@pluxel/ops'
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
					tags: ['demo', 'ops', 'status'],
				},
				input: obj({}),
				output: obj({
					pluginName: Type.String(),
					startedAt: Type.Number(),
					counter: Type.Number(),
					lastNote: Type.Union([Type.String(), Type.Null()]),
				}),
				exposure: {
					rpc: true,
				},
				execute: async () => ({
					pluginName: this.ctx.pluginInfo.id,
					startedAt: this.startedAt,
					counter: this.counter,
					lastNote: this.lastNote,
				}),
			}),
		)

		this.ctx.ops.register(
			defineOp({
				id: 'plugin-ops-demo.counter.bump',
				doc: {
					title: 'Bump PluginOpsDemo Counter',
					description: 'Increment the standalone ops demo counter.',
					tags: ['demo', 'ops', 'counter'],
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
				exposure: {
					rpc: true,
				},
				policy: {
					mutating: true,
				},
				execute: async (input) => {
					this.counter += this.normalizeDelta(input.delta)
					return { counter: this.counter }
				},
			}),
		)

		this.ctx.ops.register(
			defineOp({
				id: 'plugin-ops-demo.note.set',
				doc: {
					title: 'Set PluginOpsDemo Note',
					description: 'Store a short in-memory note through an MCP/tool-facing op.',
					tags: ['demo', 'ops', 'note'],
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
				policy: {
					mutating: true,
				},
				tool: {
					name: 'plugin-ops-demo.note.set',
				},
				execute: async (input) => {
					const message = input.message.trim()
					if (!message) throw new Error('message must not be blank')
					this.lastNote = message
					return { message: this.lastNote }
				},
			}),
		)
	}

	private normalizeDelta(value: number | undefined) {
		const normalized = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 1
		return normalized === 0 ? 1 : normalized
	}
}
