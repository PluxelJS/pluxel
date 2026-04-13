import { describe, expect, it } from 'vitest'
import { createSpace, defineOp, typebox } from '../src/index.ts'

describe('@pluxel/ops space', () => {
	it('lists operations by transport and owner', async () => {
		const space = createSpace()

		const status = defineOp({
			id: 'plugin.status.get',
			doc: {
				title: 'Get plugin status',
				description: 'Read the current plugin lifecycle state',
				details: 'Use this op when tooling needs a current lifecycle snapshot for one plugin.',
				usage: 'plugin status get --name <string>',
				examples: ['plugin status get --name demo'],
				tags: ['plugin', 'status'],
			},
			input: typebox.obj({
				name: typebox.Type.String({ description: 'Plugin name to inspect.' }),
			}),
			output: typebox.obj({
				name: typebox.Type.String(),
				running: typebox.Type.Boolean(),
			}),
			exposure: {
				rpc: true,
			},
			tool: {
				name: 'plugin_status_get',
			},
			async execute(input) {
				return { name: input.name, running: true }
			},
		})

		space.register(status, { owner: 'plugin:host' })

		expect(space.list({ carrier: 'tool' }).map((entry) => entry.id)).toContain('plugin.status.get')
		expect(space.listTools()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: 'plugin.status.get',
					name: 'plugin_status_get',
					title: 'Get plugin status',
					guidance: expect.stringContaining('Usage: plugin status get --name <string>'),
					details: 'Use this op when tooling needs a current lifecycle snapshot for one plugin.',
					usage: 'plugin status get --name <string>',
					examples: ['plugin status get --name demo'],
					tags: ['plugin', 'status'],
					inputHints: [
						{
							key: 'name',
							type: 'string',
							required: true,
							description: 'Plugin name to inspect.',
						},
					],
				}),
			]),
		)

		expect(await space.invoke('plugin.status.get', { name: 'demo' })).toEqual({
			name: 'demo',
			running: true,
		})

		expect(space.unregisterOwner('plugin:host')).toBe(1)
		expect(space.has('plugin.status.get')).toBe(false)
	})

	it('returns a structured not-found result from invokeSafe', async () => {
		const space = createSpace()
		const result = await space.invokeSafe('missing.op', {})
		expect(result.ok).toBe(false)
		if (result.ok !== false) return
		expect(result.error.code).toBe('E_OP_NOT_FOUND')
	})

	it('rolls back registry state when cli trigger registration fails', () => {
		const space = createSpace()

		space.register(
			defineOp({
				id: 'plugin.status.get',
				input: typebox.obj({
					name: typebox.Type.String({ description: 'Plugin name to inspect.' }),
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
		)

		expect(() =>
			space.register(
				defineOp({
					id: 'plugin.status.other',
					input: typebox.obj({
						name: typebox.Type.String({ description: 'Plugin name to inspect.' }),
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
		).toThrow(/trigger conflict/i)

		expect(space.has('plugin.status.other')).toBe(false)
	})

	it('freezes exported descriptors and tool metadata', () => {
		const space = createSpace()
		const unregister = space.register(
			defineOp({
				id: 'plugin.status.get',
				doc: {
					title: 'Get plugin status',
					description: 'Read the current plugin lifecycle state',
				},
				input: typebox.obj({
					name: typebox.Type.String({ description: 'Plugin name to inspect.' }),
				}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
				}),
				tool: {
					name: 'plugin_status_get',
				},
				async execute() {
					return { ok: true }
				},
			}),
		)

		const descriptor = space.getDescriptor('plugin.status.get')!
		const tool = space.listTools()[0]!
		const tools = space.listTools()
		expect(Object.isFrozen(descriptor)).toBe(true)
		expect(Object.isFrozen(tool)).toBe(true)
		expect(Object.isFrozen(tools)).toBe(true)
		expect(Object.isFrozen(descriptor.schemas.input)).toBe(true)
		unregister()
	})
})
