import { describe, expect, it } from 'vitest'
import { cli, createCliAdapter, defineOp } from '@pluxel/ops'
import { Type, obj } from '@pluxel/ops/typebox'

describe('@pluxel/ops cli adapter v2', () => {
	it('binds triggers outside the descriptor and dispatches through safe results', async () => {
		const op = defineOp({
			id: 'plugin.status',
			doc: {
				title: 'Get Plugin Status',
				description: 'Read one plugin status.',
			},
			input: obj({
				name: Type.String(),
				verbose: Type.Optional(Type.Boolean()),
			}),
			output: obj({
				name: Type.String(),
				verbose: Type.Boolean(),
			}),
			run(input) {
				return { name: input.name, verbose: input.verbose === true }
			},
		})
		const adapter = createCliAdapter()
		adapter.bind(op, { triggers: ['plugin status'] })

		await expect(adapter.dispatch('plugin status --name demo --verbose')).resolves.toEqual({
			ok: true,
			value: { name: 'demo', verbose: true },
		})
		await expect(adapter.dispatchRaw('plugin status --name demo --verbose false')).resolves.toEqual({
			name: 'demo',
			verbose: false,
		})
	})

	it('uses json tail metadata from the binding', async () => {
		const op = defineOp({
			id: 'plugin.config.patch',
			doc: {
				title: 'Patch Plugin Config',
				description: 'Patch a plugin config object.',
			},
			input: obj({
				name: Type.String(),
				patch: Type.Record(Type.String(), Type.Unknown()),
			}),
			output: obj({
				name: Type.String(),
				patch: Type.Record(Type.String(), Type.Unknown()),
			}),
			run(input) {
				return input
			},
		})
		const adapter = createCliAdapter()
		adapter.bind(op, {
			triggers: ['plugin config patch'],
			tail: cli.tail.json('patch'),
		})

		await expect(
			adapter.dispatchRaw('plugin config patch --name demo -- {"auth":{"username":"root"}}'),
		).resolves.toEqual({
			name: 'demo',
			patch: { auth: { username: 'root' } },
		})
	})

	it('merges parsebox object patches and rejects conflicts', async () => {
		const module = {
			Parse(_entry: PropertyKey, source: string) {
				const [name, verbose] = source.trim().split(/\s+/g)
				return [{ name, verbose: verbose === 'on' }, '']
			},
		}
		const op = defineOp({
			id: 'plugin.lookup',
			doc: {
				title: 'Lookup Plugin',
				description: 'Lookup a plugin using a natural tail parser.',
			},
			input: obj({
				name: Type.String(),
				verbose: Type.Optional(Type.Boolean()),
			}),
			output: obj({
				name: Type.String(),
				verbose: Type.Boolean(),
			}),
			run(input) {
				return { name: input.name, verbose: input.verbose === true }
			},
		})
		const adapter = createCliAdapter()
		adapter.bind(op, {
			triggers: ['plugin lookup'],
			tail: cli.tail.parsebox(module, 'Main'),
		})

		await expect(adapter.dispatchRaw('plugin lookup -- demo on')).resolves.toEqual({
			name: 'demo',
			verbose: true,
		})
		await expect(adapter.dispatchRaw('plugin lookup --name explicit -- demo on')).rejects.toMatchObject({
			code: 'E_CLI_PARSE',
			details: { reason: 'tail_conflict', param: 'name' },
		})
	})

	it('rejects unknown flags and requires explicit triggers', () => {
		const op = defineOp({
			id: 'plugin.search',
			doc: {
				title: 'Search Plugins',
				description: 'Search plugins by name.',
			},
			input: obj({ name: Type.String() }),
			output: obj({ name: Type.String() }),
			run(input) {
				return input
			},
		})
		const adapter = createCliAdapter()
		adapter.bind(op, { triggers: ['plugin search'] })

		expect(() => adapter.bind(op, { triggers: [] })).toThrow(/must define at least one trigger/)
		return expect(adapter.dispatchRaw('plugin search --unknown value')).rejects.toMatchObject({
			code: 'E_CLI_PARSE',
			details: { reason: 'unknown_param', param: 'unknown' },
		})
	})
})
