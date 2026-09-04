import { afterAll, test } from 'vitest'
import { Runtime } from '@sinclair/parsebox'
import { createArgvRouter } from '../src/argv'
import { createCommandRegistry, defineCommand } from '../src/index'
import { Type, obj } from '../src/typebox'

const options = { time: 500, warmupTime: 100, iterations: 10, warmupIterations: 5 }
let benchmarkSink: unknown

function consume(value: unknown): void {
	benchmarkSink = value
}

afterAll(() => {
	void benchmarkSink
})

const inputSchema = obj({
	id: Type.String(),
	count: Type.Integer(),
	verbose: Type.Optional(Type.Boolean({ default: false })),
	tags: Type.Optional(Type.Array(Type.String())),
})
const outputSchema = obj({ accepted: Type.Boolean(), count: Type.Integer() })

function defineUpdate(name = 'item.update') {
	return defineCommand({
		name,
		description: 'Update one benchmark item.',
		behavior: { kind: 'mutation', destructive: false, idempotent: true, world: 'closed' },
		input: inputSchema,
		output: outputSchema,
		execute: ({ count }) => ({ accepted: true, count }),
	})
}

const update = defineUpdate()
const input = { id: 'item-42', count: 42, tags: ['stable', 'bench'] }
const registry = createCommandRegistry()
registry.register(update)
const router = createArgvRouter()
router.bind(update, { routes: ['item update'], positionals: ['id'] })
const largePayload = Array.from({ length: 100 }, (_, index) => ({
	id: `item-${index}`,
	labels: ['stable', 'bench', `group-${index % 10}`],
	metadata: { enabled: index % 2 === 0, priority: index },
}))
const smallPayload = largePayload.slice(0, 1)
const bulk = defineCommand({
	name: 'item.bulk.inspect',
	description: 'Inspect a benchmark payload.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({ items: Type.Array(Type.Unknown()) }),
	output: obj({ items: Type.Array(Type.Unknown()) }),
	execute: ({ items }) => ({ items }),
})

const queryField = Runtime.Union([Runtime.Const('warnings'), Runtime.Const('playtime')])
const queryOperator = Runtime.Union([
	Runtime.Const('>='),
	Runtime.Const('<='),
	Runtime.Const('='),
	Runtime.Const('>'),
	Runtime.Const('<'),
])
const playerQuery = Runtime.Tuple([queryField, queryOperator, Runtime.Integer()], (values) => ({
	field: values[0],
	operator: values[1],
	threshold: Number(values[2]),
}))
const queryGrammar = new Runtime.Module({ PlayerQuery: playerQuery })
const querySchema = Type.Transform(Type.String())
	.Decode((source) => {
		const parsed = queryGrammar.Parse('PlayerQuery', source.endsWith('\n') ? source : `${source}\n`)
		if (parsed.length !== 2) throw new Error('Expected a player filter expression')
		const [expression, rest] = parsed
		if (rest.trim()) throw new Error('Unexpected player filter input')
		return { source, expression }
	})
	.Encode((query) => query.source)
const searchPlayers = defineCommand({
	name: 'players.search',
	description: 'Search benchmark players with a shared DSL.',
	behavior: { kind: 'query', world: 'closed' },
	input: obj({
		query: querySchema,
		limit: Type.Optional(Type.Integer({ default: 100 })),
	}),
	output: obj({ matched: Type.Boolean() }),
	execute: ({ query }) => ({ matched: query.expression.threshold >= 0 }),
})
const catalog = Array.from({ length: 1_000 }, (_, index) => defineUpdate(`item.update.${index}`))
const catalogRouter100 = createArgvRouter()
const catalogRouter1000 = createArgvRouter()
for (let index = 0; index < catalog.length; index += 1) {
	const command = catalog[index]!
	const binding = { routes: [`item update-${index}`], positionals: ['id'] } as const
	if (index < 100) catalogRouter100.bind(command, binding)
	catalogRouter1000.bind(command, binding)
}

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('command definition', async ({ bench }) => {
	await bench.compare(
		bench('define with cached schema identities', () => {
			consume(defineUpdate())
		}),
		bench('define with fresh schemas', () => {
			consume(
				defineCommand({
					name: 'item.fresh',
					description: 'Define one command with fresh schemas.',
					behavior: { kind: 'query', world: 'closed' },
					input: obj({ value: Type.Integer() }),
					output: obj({ value: Type.Integer() }),
					execute: ({ value }) => ({ value }),
				}),
			)
		}),
		options,
	)
})

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('validated execution, small JSON', async ({ bench }) => {
	await bench.compare(
		bench('direct execute, small JSON', async () => {
			consume(await update.execute(input))
		}),
		bench('direct execute with deadline, small JSON', async () => {
			consume(await update.execute(input, { deadlineMs: Number.MAX_SAFE_INTEGER }))
		}),
		bench('registry execute, small JSON', async () => {
			consume(await registry.execute('item.update', input))
		}),
		options,
	)
})

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('validated execution, payload scaling', async ({ bench }) => {
	await bench.compare(
		bench('direct execute, 1-item JSON round trip', async () => {
			consume(await bulk.execute({ items: smallPayload }))
		}),
		bench('direct execute, 100-item JSON round trip', async () => {
			consume(await bulk.execute({ items: largePayload }))
		}),
		options,
	)
})

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('shared ParseBox DSL', async ({ bench }) => {
	await bench('direct execute with ParseBox transform', async () => {
		consume(await searchPlayers.execute({ query: 'warnings >= 3', limit: 25 }))
	}).run(options)
})

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('catalog hot paths', async ({ bench }) => {
	await bench('1,000 registry cached lists', () => {
		let current
		for (let index = 0; index < 1_000; index += 1) current = registry.list()
		consume(current)
	}).run(options)
})

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('argv resolution scaling', async ({ bench }) => {
	await bench.compare(
		bench('100 resolves among 1 route', () => {
			let current
			for (let index = 0; index < 100; index += 1) {
				current = router.resolve('item update item-42 --count 42')
			}
			consume(current)
		}),
		bench('100 resolves among 100 routes', () => {
			let current
			for (let index = 0; index < 100; index += 1) {
				current = catalogRouter100.resolve('item update-99 item-42 --count 42')
			}
			consume(current)
		}),
		bench('100 resolves among 1,000 routes', () => {
			let current
			for (let index = 0; index < 100; index += 1) {
				current = catalogRouter1000.resolve('item update-999 item-42 --count 42')
			}
			consume(current)
		}),
		options,
	)
})

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('registry construction scaling', async ({ bench }) => {
	await bench.compare(
		bench('register 10 commands', () => {
			const current = createCommandRegistry()
			for (let index = 0; index < 10; index += 1) current.register(catalog[index]!)
			consume(current)
		}),
		bench('register 100 commands', () => {
			const current = createCommandRegistry()
			for (let index = 0; index < 100; index += 1) current.register(catalog[index]!)
			consume(current)
		}),
		bench('register 1,000 commands', () => {
			const current = createCommandRegistry()
			for (const command of catalog) current.register(command)
			consume(current)
		}),
		options,
	)
})

// oxlint-disable-next-line vitest/expect-expect -- A Vitest 5 benchmark test measures the registered work rather than asserting a result.
test('argv construction scaling', async ({ bench }) => {
	await bench.compare(
		bench('bind 10 argv routes transactionally', () => {
			const current = createArgvRouter()
			for (let index = 0; index < 10; index += 1) {
				current.bind(catalog[index]!, {
					routes: [`item update-${index}`],
					positionals: ['id'],
				})
			}
			consume(current)
		}),
		bench('bind 100 argv routes transactionally', () => {
			const current = createArgvRouter()
			for (let index = 0; index < 100; index += 1) {
				current.bind(catalog[index]!, {
					routes: [`item update-${index}`],
					positionals: ['id'],
				})
			}
			consume(current)
		}),
		bench('bind 1,000 argv routes transactionally', () => {
			const current = createArgvRouter()
			for (let index = 0; index < catalog.length; index += 1) {
				current.bind(catalog[index]!, {
					routes: [`item update-${index}`],
					positionals: ['id'],
				})
			}
			consume(current)
		}),
		options,
	)
})
