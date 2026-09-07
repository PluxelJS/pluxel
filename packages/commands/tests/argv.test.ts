import { describe, expect, it } from 'vitest'
import { Runtime } from '@sinclair/parsebox'
import {
	CommandError,
	defineCommand,
	validation,
	type Command,
	type CommandContext,
} from '../src/index'
import { createArgvRouter, tail } from '../src/argv'
import { Type, obj } from '../src/typebox'

const deploy = defineCommand({
	name: 'service.deploy',
	title: 'Deploy service',
	description: 'Deploy one service.',
	behavior: {
		kind: 'mutation',
		destructive: false,
		idempotent: false,
		world: 'open',
	},
	input: obj({
		service: Type.String({ description: 'Service name.' }),
		environment: Type.Union([Type.Literal('stage'), Type.Literal('prod')]),
		force: Type.Optional(Type.Boolean({ default: false })),
		tag: Type.Optional(Type.Array(Type.String())),
	}),
	output: obj({ ok: Type.Boolean() }),
	execute() {
		return { ok: true }
	},
})

describe('@pluxel/commands argv', () => {
	const assertTextTailTypes = () => {
		tail.text<{ message: string; optional?: string; count: number }>('message')
		tail.text<{ message: string; optional?: string; count: number }>('optional')
		// @ts-expect-error Text tails bind only string wire fields.
		tail.text<{ message: string; optional?: string; count: number }>('count')
		createArgvRouter().bind(deploy, {
			routes: ['deploy'],
			// @ts-expect-error The surrounding command binding infers that force is boolean.
			tail: tail.text('force'),
		})
		const retagInput = (_command: Command<{ missing: string }>): void => {}
		// @ts-expect-error Command input types are invariant and cannot be relabeled for argv binding.
		retagInput(deploy)

		const dynamicRouter = createArgvRouter()
		dynamicRouter.bind(deploy, { routes: ['deploy'] })
		const dynamicResolution = dynamicRouter.resolve('deploy')
		if (dynamicResolution) {
			// @ts-expect-error A heterogeneous router cannot promise one command's output type.
			const output: Promise<{ ok: boolean }> = dynamicResolution.command.execute({})
			void output
		}

		const homogeneousRouter = createArgvRouter<CommandContext, { ok: boolean }>()
		homogeneousRouter.bind(deploy, { routes: ['deploy'] })
		const homogeneousResolution = homogeneousRouter.resolve('deploy')
		if (homogeneousResolution) {
			const output: Promise<{ ok: boolean }> = homogeneousResolution.command.execute({})
			void output
		}
	}
	void assertTextTailTypes

	it('resolves longest routes, typed positionals, flags, enums, and repeated arrays', async () => {
		const router = createArgvRouter()
		router.bind(deploy, {
			routes: ['deploy', 'service deploy'],
			positionals: ['service'],
			options: { force: { aliases: ['F'] }, environment: { aliases: ['e'] } },
		})
		const resolved = router.resolve(
			'service deploy api --environment prod -F --tag stable --tag latest',
		)
		expect(resolved).toMatchObject({
			route: 'service deploy',
			candidate: {
				service: 'api',
				environment: 'prod',
				force: true,
				tag: ['stable', 'latest'],
			},
		})
		expect(
			router.resolve(['service', 'deploy', 'api worker', '--environment', 'prod'])?.candidate,
		).toEqual({ service: 'api worker', environment: 'prod' })
		const descriptor = router.list()[0]!
		expect(descriptor.usage).toContain('deploy <service>')
		expect(descriptor.usage).toContain('--environment <string>')
		expect(descriptor.parameters[0]).not.toHaveProperty('schema')
		expect(descriptor.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: 'environment',
					name: 'environment',
					aliases: ['e'],
					choices: ['stage', 'prod'],
				}),
				expect.objectContaining({
					key: 'force',
					name: 'force',
					aliases: ['F'],
					defaultValue: false,
				}),
			]),
		)
		expect(router.resolve('deploy api --environment stage --no-force')?.candidate).toMatchObject({
			force: false,
		})
		expect(() => router.resolve('deploy api --enviroment prod')).toThrow(
			/Did you mean "--environment"/,
		)
		let choiceFailure: unknown
		try {
			router.resolve('deploy api --environment prdo')
		} catch (error) {
			choiceFailure = error
		}
		expect(choiceFailure).toMatchObject({
			code: 'ARGUMENT_SYNTAX',
			details: {
				reason: 'invalid_choice',
				parameter: 'environment',
				allowedValues: ['stage', 'prod'],
				suggestions: ['prod'],
			},
		})
		expect(router.resolve('service deplo api --environment prod')).toBeUndefined()
	})

	it('validates router limits when the router is created', () => {
		expect(() => createArgvRouter({ maxTextLength: 0 })).toThrow(/positive safe integer/)
		expect(() => createArgvRouter({ maxTextLength: Number.NaN })).toThrow(/positive safe integer/)
		const router = createArgvRouter({ maxTextLength: 3 })
		expect(() => router.resolve('four')).toThrow(/exceeds 3 characters/)
	})

	it('returns an immutable idempotent route registration', () => {
		const router = createArgvRouter()
		const registration = router.bind(deploy, { routes: ['deploy'] })
		expect(Object.isFrozen(registration)).toBe(true)
		registration.dispose()
		registration.dispose()
		expect(router.list()).toEqual([])
	})

	it('ends option parsing with -- before consuming remaining positionals and tail', () => {
		const command = defineCommand({
			name: 'message.send',
			description: 'Send one message.',
			behavior: { kind: 'mutation', destructive: false, idempotent: false, world: 'closed' },
			input: obj({
				user: Type.String(),
				message: Type.String(),
				silent: Type.Optional(Type.Boolean({ default: false })),
			}),
			execute() {},
		})
		const router = createArgvRouter()
		router.bind(command, {
			routes: ['send'],
			positionals: ['user'],
			options: { silent: { aliases: ['s'] } },
			tail: { mode: 'text', key: 'message' },
		})

		const expected = { user: 'alice', silent: true, message: 'hello world' }
		expect(router.resolve('send alice -s hello world')?.candidate).toEqual(expected)
		expect(router.resolve('send -s alice hello world')?.candidate).toEqual(expected)
		expect(router.resolve('send -s -- alice hello world')?.candidate).toEqual(expected)

		expect(() =>
			createArgvRouter().bind(command, {
				routes: ['invalid send'],
				positionals: ['user'],
				options: { user: { name: 'recipient' } },
				tail: { mode: 'text', key: 'message' },
			}),
		).toThrow(/also positional/)
		expect(() =>
			createArgvRouter().bind(command, {
				routes: ['invalid text tail'],
				// Simulate an untyped JavaScript caller bypassing the public key constraint.
				tail: { mode: 'text', key: 'silent' } as never,
			}),
		).toThrow(/must use a string input schema/)
	})

	it('requires an explicit JSON mapping for complex option schemas', () => {
		const command = defineCommand({
			name: 'config.patch',
			description: 'Patch config values.',
			behavior: {
				kind: 'mutation',
				destructive: false,
				idempotent: true,
				world: 'closed',
			},
			input: obj({ patch: obj({ enabled: Type.Boolean() }) }),
			output: obj({ ok: Type.Boolean() }),
			execute: () => ({ ok: true }),
		})
		const router = createArgvRouter()
		expect(() => router.bind(command, { routes: ['config patch'] })).toThrow(/complex schema/)
		router.bind(command, {
			routes: ['config patch'],
			options: { patch: { format: 'json' } },
		})
		expect(router.resolve(`config patch --patch '{"enabled":true}'`)?.candidate).toEqual({
			patch: { enabled: true },
		})
	})

	it('displays one canonical option name while accepting practical spelling variants', () => {
		const command = defineCommand({
			name: 'retry.configure',
			description: 'Configure retry count.',
			behavior: { kind: 'mutation', destructive: false, idempotent: true, world: 'closed' },
			input: obj({ retryCount: Type.Integer() }),
			execute() {},
		})
		const router = createArgvRouter()
		router.bind(command, { routes: ['retry configure'] })

		expect(router.resolve('retry configure --retry-count 2')?.candidate).toEqual({ retryCount: 2 })
		expect(router.resolve('retry configure --RETRY-COUNT 2')?.candidate).toEqual({ retryCount: 2 })
		expect(router.resolve('retry configure --retry_count 2')?.candidate).toEqual({ retryCount: 2 })
		expect(router.list()[0]?.parameters).toEqual([
			expect.objectContaining({ name: 'retry-count', aliases: [] }),
		])
		expect(() => router.resolve('retry configure --retryCount 2')).toThrow(/Unknown option/)
	})

	it('prefers an exact no-prefixed boolean option before boolean negation shorthand', () => {
		const command = defineCommand({
			name: 'cache.configure',
			description: 'Configure cache behavior.',
			behavior: { kind: 'mutation', destructive: false, idempotent: true, world: 'closed' },
			input: obj({
				cache: Type.Optional(Type.Boolean()),
				noCache: Type.Optional(Type.Boolean()),
			}),
			execute() {},
		})
		const router = createArgvRouter()
		router.bind(command, { routes: ['cache configure'] })

		expect(router.list()[0]?.usage).toContain('--no-cache')
		expect(router.resolve('cache configure --no-cache')?.candidate).toEqual({ noCache: true })
		expect(router.resolve('cache configure --no-cache=false')?.candidate).toEqual({
			noCache: false,
		})
		expect(router.resolve('cache configure --cache=false')?.candidate).toEqual({ cache: false })
	})

	it('treats schema field names as data instead of object prototype operations', () => {
		const command = defineCommand({
			name: 'object.prototype.field',
			description: 'Accept a field whose name has JavaScript prototype meaning.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({ ['__proto__']: Type.String() }),
			execute() {},
		})
		const router = createArgvRouter()
		router.bind(command, {
			routes: ['prototype field'],
			options: { ['__proto__']: { name: 'value' } },
		})

		const candidate = router.resolve('prototype field --value safe')?.candidate
		expect(Object.getPrototypeOf(candidate)).toBe(Object.prototype)
		expect(candidate).toHaveProperty('__proto__', 'safe')
	})

	it('shares one ParseBox DSL across Agent input and argv while execution receives its product', async () => {
		const field = Runtime.Union([Runtime.Const('warnings'), Runtime.Const('playtime')])
		const operator = Runtime.Union([
			Runtime.Const('>='),
			Runtime.Const('<='),
			Runtime.Const('='),
			Runtime.Const('>'),
			Runtime.Const('<'),
		])
		const playerQuery = Runtime.Tuple([field, operator, Runtime.Integer()], (values) => ({
			field: values[0],
			operator: values[1],
			threshold: Number(values[2]),
		}))
		const grammar = new Runtime.Module({ PlayerQuery: playerQuery })
		const invalidQuery = (message: string): never => {
			throw new CommandError('INPUT_VALIDATION', 'Invalid command input', {
				details: {
					issues: [validation.constraint('query', message, { code: 'invalid_query' })],
				},
			})
		}
		const query = Type.Transform(
			Type.String({
				description:
					'Player filter DSL. Syntax: <field> <operator> <integer>; fields: warnings, playtime; operators: >=, <=, =, >, <.',
				examples: ['warnings >= 3', 'playtime < 10'],
			}),
		)
			.Decode((source) => {
				const parsed = grammar.Parse('PlayerQuery', source.endsWith('\n') ? source : `${source}\n`)
				if (parsed.length !== 2) return invalidQuery('Expected a player filter expression')
				const [expression, rest] = parsed
				if (rest.trim()) return invalidQuery(`Unexpected query input: ${rest.trim()}`)
				return { source, expression }
			})
			.Encode((decoded) => decoded.source)
		let received: unknown
		const command = defineCommand({
			name: 'players.search.dsl',
			description: 'Search players with the shared player filter DSL.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({
				query,
				limit: Type.Optional(Type.Integer({ default: 100 })),
			}),
			examples: [{ input: { query: 'warnings >= 3', limit: 25 } }],
			execute(input) {
				received = input
			},
		})

		const optionRouter = createArgvRouter()
		optionRouter.bind(command, {
			routes: ['players filter'],
			options: { query: { aliases: ['q'] }, limit: { aliases: ['l'] } },
		})
		const optionResolution = optionRouter.resolve(
			'players filter --query "playtime < 10" --limit 25',
		)!
		await optionResolution.command.execute(optionResolution.candidate)
		expect(received).toMatchObject({
			query: { expression: { field: 'playtime', operator: '<', threshold: 10 } },
		})

		const textTailRouter = createArgvRouter()
		textTailRouter.bind(command, {
			routes: ['players search'],
			options: { limit: { aliases: ['l'] } },
			tail: tail.text('query', '<filter-expression>'),
		})
		const tailResolution = textTailRouter.resolve('players search --limit 25 --   playtime < 10')!
		await tailResolution.command.execute(tailResolution.candidate)
		expect(received).toMatchObject({ query: { source: 'playtime < 10' }, limit: 25 })
		await expect(command.execute({ query: 'warnings >= 3 trailing' })).rejects.toMatchObject({
			code: 'INPUT_VALIDATION',
			details: {
				issues: [
					{
						path: ['query'],
						message: 'Unexpected query input: trailing',
						code: 'invalid_query',
					},
				],
			},
		})
	})

	it('builds route changes atomically when a conflict is rejected', () => {
		const router = createArgvRouter()
		router.bind(deploy, { routes: ['deploy'], positionals: ['service'] })
		const other = defineCommand({
			name: 'service.other',
			description: 'Another command.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			output: obj({ ok: Type.Boolean() }),
			execute: () => ({ ok: true }),
		})
		expect(() => router.bind(other, { routes: ['deploy'] })).toThrow(/already bound/)
		expect(router.resolve('deploy api --environment stage')?.command.name).toBe('service.deploy')
	})

	it('removes every route for a disposed binding while preserving shared prefixes', () => {
		const router = createArgvRouter()
		const deployRegistration = router.bind(deploy, {
			routes: ['deploy', 'service deploy'],
			positionals: ['service'],
		})
		const status = defineCommand({
			name: 'service.status',
			description: 'Read service status.',
			behavior: { kind: 'query', world: 'closed' },
			input: obj({}),
			execute() {},
		})
		router.bind(status, { routes: ['deploy status'] })

		deployRegistration.dispose()
		expect(router.resolve('deploy api --environment stage')).toBeUndefined()
		expect(router.resolve('service deploy api --environment stage')).toBeUndefined()
		expect(router.resolve('deploy status')?.command.name).toBe('service.status')
	})
})
