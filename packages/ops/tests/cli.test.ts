import { describe, expect, it } from 'vitest'
import { Runtime } from '@sinclair/parsebox'
import { cli, createSpace, defineOp, typebox } from '../src/index.ts'

describe('@pluxel/ops cli entrypoint', () => {
	it('dispatches schema-derived flags with implicit line tail', async () => {
		const space = createSpace()
		space.register(
			defineOp({
				id: 'plugin.search',
				doc: {
					title: 'Search Plugins',
					description: 'Search plugins by free text',
					details: 'Accepts schema-derived flags and a free-text tail query.',
					usage: 'plugin search --name <string> [--verbose] [--query <string>] <text>',
					examples: ['plugin search --name demo hello world'],
					tags: ['plugin', 'search'],
				},
				input: typebox.obj({
					name: typebox.Type.String(),
					verbose: typebox.Type.Optional(typebox.Type.Boolean({ default: false })),
					query: typebox.Type.Optional(typebox.Type.String()),
				}),
				output: typebox.obj({
					text: typebox.Type.String(),
				}),
				cli: {
					triggers: ['plugin search'],
					tail: cli.tail.line('query'),
				},
				async execute(input) {
					return {
						text: `${input.name}|${String(input.verbose)}|${input.query ?? ''}`,
					}
				},
			}),
		)

		await expect(space.dispatch('plugin search --name demo --verbose hello world')).resolves.toEqual({
			text: 'demo|true|hello world',
		})

		expect(space.helpCommand('plugin search')).toEqual(
			expect.objectContaining({
				id: 'plugin.search',
				title: 'Search Plugins',
				details: 'Accepts schema-derived flags and a free-text tail query.',
				examples: ['plugin search --name demo hello world'],
				tags: ['plugin', 'search'],
				usage: 'plugin search --name <string> [--verbose] [--query <string>] <text>',
			}),
		)
		expect(Object.isFrozen(space.helpIndex())).toBe(true)
		expect(Object.isFrozen(space.helpIndex().list)).toBe(true)
	})

	it('supports explicit JSON tail payloads', async () => {
		const space = createSpace()
		space.register(
			defineOp({
				id: 'plugin.config.patch',
				doc: {
					description: 'Patch plugin config with a JSON object payload',
				},
				input: typebox.obj({
					name: typebox.Type.String(),
					patch: typebox.openObj({}),
				}),
				output: typebox.obj({
					ok: typebox.Type.Boolean(),
					keys: typebox.Type.Array(typebox.Type.String()),
				}),
				cli: {
					triggers: ['plugin config patch'],
					tail: cli.tail.json('patch'),
				},
				async execute(input) {
					return { ok: true, keys: Object.keys(input.patch) }
				},
			}),
		)

		await expect(
			space.dispatch('plugin config patch --name demo -- {"auth":{"username":"root"}}'),
		).resolves.toEqual({
			ok: true,
			keys: ['auth'],
		})
	})

	it('supports ParseBox tails that produce structured object patches', async () => {
		const space = createSpace()
		const module = new Runtime.Module({
			Main: Runtime.Until(['\n'], (source) => {
				const [name = '', mode = 'off'] = String(source ?? '')
					.trim()
					.split(/\s+/g)
					.filter(Boolean)
				return {
					name,
					verbose: mode === 'on',
				}
			}),
		})

		space.register(
			defineOp({
				id: 'plugin.lookup',
				input: typebox.obj({
					name: typebox.Type.String(),
					verbose: typebox.Type.Optional(typebox.Type.Boolean({ default: false })),
				}),
				output: typebox.obj({
					text: typebox.Type.String(),
				}),
				cli: {
					triggers: ['plugin lookup'],
					tail: cli.tail.parsebox(module, 'Main', { placeholder: '<name verbose:on|off>' }),
				},
				async execute(input) {
					return { text: `${input.name}:${String(input.verbose)}` }
				},
			}),
		)

		await expect(space.dispatch('plugin lookup -- demo on')).resolves.toEqual({
			text: 'demo:true',
		})
	})

	it('rejects unknown flags instead of silently dropping them', async () => {
		const space = createSpace()
		space.register(
			defineOp({
				id: 'plugin.search',
				input: typebox.obj({
					name: typebox.Type.String(),
					query: typebox.Type.Optional(typebox.Type.String()),
				}),
				output: typebox.obj({
					text: typebox.Type.String(),
				}),
				cli: {
					triggers: ['plugin search'],
					tail: cli.tail.line('query'),
				},
				async execute(input) {
					return { text: `${input.name}:${input.query ?? ''}` }
				},
			}),
		)

		await expect(
			space.dispatch('plugin search --name demo --unknown value'),
		).rejects.toMatchObject({
			code: 'E_CLI_PARSE',
		})
	})
})
