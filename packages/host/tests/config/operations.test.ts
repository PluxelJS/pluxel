import { BasePlugin, Plugin, parsePluginNodeAddress } from '@pluxel/core'
import { SuperJSON } from 'superjson'
import * as v from 'valibot'
import { extractFormFields, formMeta } from 'valibot-form'
import { buildEditableConfigPatch, editableConfigPaths } from 'valibot-form/web'
import { beforeEach, expect, it } from 'vitest'
import { createHost } from '../../src/index'
import { createDocumentStorage } from '../support/document-storage'

const normalizations: string[] = []
const schema = v.object({
	title: v.pipe(
		v.optional(v.string(), 'Standard'),
		v.trim(),
		v.nonEmpty(),
		v.transform((title) => {
			normalizations.push(title)
			return title
		}),
	),
	limit: v.optional(v.number(), 5),
	destination: v.optional(
		v.variant('kind', [
			v.strictObject({ kind: v.literal('file'), path: v.string() }),
			v.strictObject({ kind: v.literal('queue'), topic: v.string() }),
		]),
		{ kind: 'file', path: 'reports.json' },
	),
})

const adopted = new Map<string, string>()

@Plugin({ forkable: true })
class Board extends BasePlugin {
	readonly config = this.configs.use(schema)

	init() {
		const address = this.ctx.pluginInfo.nodeAddress
		const name = address.variant === 'fork' ? address.forkId : 'default'
		adopted.set(name, this.config.title)
		this.configs.onUpdate(this.config, ({ desired }) => {
			if (desired.title === 'Maintenance')
				throw new Error('Busy board cannot apply maintenance live')
			adopted.set(name, desired.title)
		})
	}
}

beforeEach(() => {
	adopted.clear()
	normalizations.length = 0
})

it('validates before saving, then applies only the winning edit to its addressed fork', async () => {
	const disk = createDocumentStorage()
	const east = Board.nodeAddress('east')
	const west = Board.nodeAddress('west')
	const options = {
		plugins: [
			{
				plugin: Board,
				config: { title: 'Shared' },
				forks: { east: { autoStart: true }, west: { autoStart: true } },
			},
		],
		policy: { document: false as const },
		config: { mode: 'saved-first' as const, document: { storage: () => disk } },
	}
	await using host = await createHost(options)
	await host.start()
	const before = await host.config.get(east)
	if (before.ok === false) throw new Error(before.message)
	const change = { set: { title: '  East board  ' } }
	await expect(host.config.validate(east, change)).resolves.toMatchObject({
		ok: true,
		config: { title: 'East board', limit: 5 },
	})
	await expect(host.config.patch(east, { set: { title: ' ' } })).resolves.toMatchObject({
		ok: false,
		code: 'validation_failed',
		state: 'unchanged',
	})
	expect(await disk.getText('config.json')).toBeUndefined()
	expect(adopted.get('east')).toBe('Shared')

	const expected = { expectedManagedRevision: before.managedRevision }
	const [saved, stale] = await Promise.all([
		host.config.patch(east, change, expected),
		host.config.patch(east, { set: { title: 'Stale edit' } }, expected),
	])
	expect(saved).toMatchObject({
		ok: true,
		application: 'applied',
		persistence: { status: 'confirmed' },
	})
	expect(stale).toMatchObject({ ok: false, code: 'revision_conflict', state: 'unchanged' })
	const beforePreflight = [...normalizations]
	await expect(host.config.validate(east, change, expected)).resolves.toMatchObject({
		ok: false,
		code: 'revision_conflict',
		state: 'unchanged',
	})
	expect(normalizations).toEqual(beforePreflight)
	expect(adopted).toEqual(
		new Map([
			['east', 'East board'],
			['west', 'Shared'],
		]),
	)
	await expect(host.config.get(west)).resolves.toMatchObject({
		managedInput: null,
		config: { title: 'Shared' },
	})
	const document = await disk.getText('config.json')
	expect(SuperJSON.parse(document!)).toEqual({
		version: 4,
		plugins: [{ owner: parsePluginNodeAddress(east), config: { title: '  East board  ' } }],
	})
	await host.close()

	await using reopened = await createHost({
		...options,
		config: { ...options.config, document: { storage: () => disk, readOnly: true } },
	})
	await reopened.start()
	await expect(reopened.config.get(east)).resolves.toMatchObject({
		readonly: true,
		managedInput: { title: '  East board  ' },
		config: { title: 'East board', limit: 5 },
	})
	await expect(reopened.config.reset(east)).resolves.toMatchObject({
		ok: false,
		code: 'mutation_rejected',
	})
	expect(await disk.getText('config.json')).toBe(document)
})

it('distinguishes a stopped node, a failed live adoption, and the next generation reading the saved value', async () => {
	const node = Board.nodeAddress()
	await using host = await createHost({
		plugins: [{ plugin: Board }],
		policy: { document: false },
	})
	await host.start()
	await expect(host.config.patch(node, { set: { title: 'Drafts' } })).resolves.toMatchObject({
		ok: true,
		application: 'deferred',
		appliedRevision: null,
	})
	expect(adopted.has('default')).toBe(false)
	await host.startNode(node)
	const running = await host.config.get(node)
	if (running.ok === false) throw new Error(running.message)
	await expect(host.config.patch(node, { set: { title: 'Maintenance' } })).resolves.toMatchObject({
		ok: true,
		application: 'saved-not-applied',
		appliedRevision: running.appliedRevision,
		config: { title: 'Maintenance' },
		applyFailure: { code: 'listener_failed' },
	})
	expect(adopted.get('default')).toBe('Drafts')
	await host.restartNode(node)
	expect(adopted.get('default')).toBe('Maintenance')
	await expect(host.config.reset(node)).resolves.toMatchObject({
		ok: true,
		application: 'applied',
		managedInput: null,
		config: { title: 'Standard' },
	})
})

it('keeps the live configuration when storage may have committed without acknowledging it', async () => {
	const disk = createDocumentStorage()
	const node = Board.nodeAddress()
	let loseAcknowledgement = false
	const options = {
		plugins: [{ plugin: Board, autoStart: true }],
		policy: { document: false as const },
		config: {
			document: {
				storage: () => ({
					...disk,
					async put(key: string, value: string) {
						await disk.put(key, value)
						if (loseAcknowledgement) throw new Error('Write acknowledgement lost')
					},
				}),
			},
		},
	}
	await using host = await createHost(options)
	await host.start()
	await host.config.patch(node, { set: { title: 'Confirmed' } })
	const confirmed = await host.config.get(node)
	if (confirmed.ok === false) throw new Error(confirmed.message)
	loseAcknowledgement = true
	await expect(host.config.patch(node, { set: { title: 'Unconfirmed' } })).resolves.toMatchObject({
		ok: false,
		code: 'persistence_failed',
		state: 'unknown',
		persistence: { status: 'unknown' },
		managedInput: { title: 'Confirmed' },
		managedRevision: confirmed.managedRevision,
	})
	await expect(host.config.get(node)).resolves.toEqual(confirmed)
	expect(adopted.get('default')).toBe('Confirmed')
	await host.close()

	await using reopened = await createHost(options)
	await reopened.start()
	expect(adopted.get('default')).toBe('Unconfirmed')
})

it('retains shadowed raw input and reports it when new deployment priority requires a repair', async () => {
	const disk = createDocumentStorage()
	const node = Board.nodeAddress()
	const options = {
		plugins: [{ plugin: Board, config: { title: 'Deploy title' } }],
		policy: { document: false as const },
	}
	await using host = await createHost({ ...options, config: { document: { storage: () => disk } } })
	const before = await host.config.get(node)
	if (before.ok === false) throw new Error(before.message)
	await expect(host.config.patch(node, { set: { title: 42 } })).resolves.toMatchObject({
		ok: true,
		managedInput: { title: 42 },
		config: { title: 'Deploy title' },
		desiredRevision: before.desiredRevision,
		shadowedPaths: [['title']],
	})
	expect(normalizations).toEqual(['Deploy title'])
	await host.close()

	await using reopened = await createHost({
		...options,
		config: {
			mode: 'saved-first',
			document: {
				storage: () => ({
					...disk,
					async put() {
						throw new Error('Offline')
					},
				}),
			},
		},
	})
	await expect(reopened.config.get(node)).resolves.toMatchObject({
		ok: false,
		code: 'validation_failed',
		managedInput: { title: 42 },
	})
	await expect(reopened.config.patch(node, { set: { title: 'Repaired' } })).resolves.toMatchObject({
		ok: false,
		code: 'persistence_failed',
		state: 'unknown',
		managedInput: { title: 42 },
		effectiveInput: { title: 42 },
	})
})

it('replaces a configuration branch in one save and restores its default on reset', async () => {
	const node = Board.nodeAddress()
	await using host = await createHost({
		plugins: [{ plugin: Board }],
		config: { document: false },
		policy: { document: false },
	})
	await expect(host.config.patch(node, { set: {} })).resolves.toMatchObject({ managedInput: {} })
	await expect(host.config.reset(node, [['missing']])).resolves.toMatchObject({
		managedInput: {},
		persistence: { status: 'unchanged' },
	})
	const file = { destination: { kind: 'file', path: 'local.json' } }
	const queue = { destination: { kind: 'queue', topic: 'alerts' } }
	await expect(host.config.patch(node, { set: file })).resolves.toMatchObject({ config: file })
	await expect(host.config.patch(node, { set: queue })).resolves.toMatchObject({
		ok: false,
		code: 'validation_failed',
	})
	for (const remove of [
		[['destination'], ['destination', 'path']],
		[['__proto__']],
		[Array(1) as string[]],
	]) {
		await expect(host.config.patch(node, { remove })).resolves.toMatchObject({
			ok: false,
			code: 'invalid_input',
		})
	}
	await expect(host.config.get(node)).resolves.toMatchObject({ config: file, managedInput: file })
	await expect(
		host.config.patch(node, { set: queue, remove: [['destination']] }),
	).resolves.toMatchObject({
		ok: true,
		managedInput: queue,
		config: queue,
	})
	await expect(host.config.reset(node, [['destination']])).resolves.toMatchObject({
		ok: true,
		managedInput: null,
		config: { destination: { kind: 'file', path: 'reports.json' } },
	})
})

const choiceSchema = v.union([
	v.object({
		label: v.string(),
		token: v.pipe(v.optional(v.string()), formMeta({ hidden: true })),
	}),
	v.object({ target: v.string() }),
])
const sparseSchema = v.object({
	opts: v.optional(
		v.nullable(
			v.object({
				tag: v.optional(v.string()),
				'a.b': v.optional(v.string()),
				a: v.optional(v.object({ b: v.string() })),
			}),
		),
		{ tag: 'fallback' },
	),
	rows: v.optional(v.array(v.object({ name: v.string(), opaque: v.unknown() })), []),
	protected: v.pipe(v.optional(v.string()), formMeta({ hidden: true })),
	sibling: v.optional(v.boolean(), true),
	choice: v.optional(choiceSchema),
	choices: v.optional(v.array(choiceSchema)),
	labels: v.optional(v.record(v.string(), v.string())),
	priorities: v.optional(v.array(v.number())),
})

@Plugin()
class SparseBoard extends BasePlugin {
	readonly config = this.configs.use(sparseSchema)
}

it('round-trips sparse editor patches and scoped inheritance through Host readback', async () => {
	const owner = SparseBoard.nodeAddress()
	const fields = extractFormFields(sparseSchema)
	const optsFields = fields.filter(({ name }) => name === 'opts')
	const preserved = {
		protected: 'saved',
		rows: [{ name: 'one', opaque: { count: 4 }, future: 'keep' }],
	}
	const sibling = { ...preserved, sibling: false }
	await using host = await createHost({
		plugins: [{ plugin: SparseBoard }],
		config: { document: false },
		policy: { document: false },
	})
	await expect(host.config.patch(owner, { set: sibling })).resolves.toMatchObject({ ok: true })
	async function read(managedInput: Record<string, unknown>, options: unknown) {
		const result = await host.config.get(owner)
		if (result.ok === false) throw new Error(result.message)
		expect(result.config).toMatchObject({ opts: options, sibling: false })
		expect(result.managedInput).toEqual(managedInput)
		expect(result.effectiveInput).toEqual(managedInput)
		return result.managedInput!
	}
	async function save(
		input: Record<string, unknown>,
		expected: Record<string, unknown>,
		opts: unknown,
	) {
		const current = await host.config.get(owner)
		if (current.ok === false) throw new Error(current.message)
		const patch = buildEditableConfigPatch(fields, input, current.managedInput!)
		await expect(
			host.config.patch(owner, patch, {
				expectedManagedRevision: current.managedRevision,
			}),
		).resolves.toMatchObject({ ok: true })
		await read(expected, opts)
		return patch
	}
	await read(sibling, { tag: 'fallback' })
	expect(await save({ ...sibling, opts: {} }, { ...sibling, opts: {} }, {})).toEqual({
		set: { opts: {} },
	})
	await save(
		{ ...sibling, opts: null, rows: [], protected: 'discarded' },
		{ ...sibling, opts: null },
		null,
	)
	const nullInput = await read({ ...sibling, opts: null }, null)
	const nullRemoval = buildEditableConfigPatch(optsFields, {}, nullInput)
	expect(nullRemoval).toEqual({ remove: [['opts']] })
	await expect(host.config.patch(owner, nullRemoval)).resolves.toMatchObject({ ok: true })
	await read(sibling, { tag: 'fallback' })
	await save({ ...sibling, opts: null }, { ...sibling, opts: null }, null)
	await expect(
		host.config.reset(
			owner,
			editableConfigPaths(optsFields, await read({ ...sibling, opts: null }, null)),
		),
	).resolves.toMatchObject({ ok: true })
	await read(sibling, { tag: 'fallback' })
	await save({ ...sibling, opts: null }, { ...sibling, opts: null }, null)
	expect(
		await save(
			{ ...sibling, opts: { tag: 'x' } },
			{ ...sibling, opts: { tag: 'x' } },
			{ tag: 'x' },
		),
	).toEqual({ set: { opts: { tag: 'x' } } })
	expect(await save({ ...sibling, opts: {} }, { ...sibling, opts: {} }, {})).toEqual({
		remove: [['opts', 'tag']],
		set: { opts: {} },
	})
	await expect(
		host.config.reset(
			owner,
			editableConfigPaths(
				fields.filter(({ name }) => name !== 'sibling'),
				await read({ ...sibling, opts: {} }, {}),
			),
		),
	).resolves.toMatchObject({ ok: true })
	await read(sibling, { tag: 'fallback' })
	await save(
		{ ...sibling, opts: { 'a.b': 'literal', a: { b: 'nested' } } },
		{ ...sibling, opts: { 'a.b': 'literal', a: { b: 'nested' } } },
		{ 'a.b': 'literal', a: { b: 'nested' } },
	)
	const literalEdit = { 'a.b': 'edited', a: { b: 'nested' } }
	expect(
		await save({ ...sibling, opts: literalEdit }, { ...sibling, opts: literalEdit }, literalEdit),
	).toEqual({ set: { opts: { 'a.b': 'edited' } } })
	const paths = editableConfigPaths(
		fields.filter(({ name }) => name !== 'sibling'),
		await read({ ...sibling, opts: literalEdit }, literalEdit),
	)
	expect(paths).toEqual([
		['opts', 'a.b'],
		['opts', 'a', 'b'],
	])
	await expect(host.config.reset(owner, paths)).resolves.toMatchObject({ ok: true })
	await read(sibling, { tag: 'fallback' })
})

it('preserves protected values in untagged object unions during saves and scoped restores', async () => {
	await using host = await createHost({
		plugins: [{ plugin: SparseBoard }],
		config: { document: false },
		policy: { document: false },
	})
	const owner = SparseBoard.nodeAddress()
	const fields = extractFormFields(sparseSchema)
	const protectedValues = {
		choice: { label: 'one', token: 'keep' },
		choices: [{ target: 'two', future: 'keep' }],
	}
	const before = await host.config.patch(owner, { set: { ...protectedValues, sibling: false } })
	if (before.ok === false) throw new Error(before.message)
	const patch = buildEditableConfigPatch(
		fields,
		{ choices: [], sibling: true },
		before.managedInput!,
	)
	expect(patch).toEqual({ set: { sibling: true } })
	const saved = await host.config.patch(owner, patch, {
		expectedManagedRevision: before.managedRevision,
	})
	if (saved.ok === false) throw new Error(saved.message)
	expect(await host.config.get(owner)).toMatchObject({
		ok: true,
		managedInput: { ...protectedValues, sibling: true },
	})
	const paths = editableConfigPaths(fields, saved.managedInput!)
	expect(paths).toEqual([['sibling']])
	await expect(
		host.config.reset(owner, paths, { expectedManagedRevision: saved.managedRevision }),
	).resolves.toMatchObject({ ok: true })
	const readback = await host.config.get(owner)
	if (readback.ok === false) throw new Error(readback.message)
	expect(readback.managedInput).toEqual(protectedValues)
})

it('treats array order as a saved change and record key order as presentation', async () => {
	await using host = await createHost({
		plugins: [{ plugin: SparseBoard }],
		config: { document: false },
		policy: { document: false },
	})
	const owner = SparseBoard.nodeAddress()
	const fields = extractFormFields(sparseSchema)
	const labels = { first: 'a', second: 'b' }
	const priorities = [1, 2]
	const before = await host.config.patch(owner, { set: { labels, priorities } })
	if (before.ok === false) throw new Error(before.message)
	const reordered = { labels: { second: 'b', first: 'a' }, priorities }
	expect(buildEditableConfigPatch(fields, reordered, before.managedInput!)).toEqual({})
	const patch = buildEditableConfigPatch(
		fields,
		{ ...reordered, priorities: [2, 1] },
		before.managedInput!,
	)
	expect(patch).toEqual({ set: { priorities: [2, 1] } })
	await expect(host.config.patch(owner, patch)).resolves.toMatchObject({ ok: true })
	const readback = await host.config.get(owner)
	if (readback.ok === false) throw new Error(readback.message)
	expect(readback.managedInput).toEqual({ labels, priorities: [2, 1] })
})

it('settles a save already writing to storage and cancels the edit still waiting behind it', async () => {
	const disk = createDocumentStorage()
	const writing = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const storage = {
		...disk,
		async put(key: string, value: string) {
			writing.resolve()
			await release.promise
			await disk.put(key, value)
		},
	}
	const node = Board.nodeAddress()
	await using host = await createHost({
		plugins: [{ plugin: Board, autoStart: true }],
		config: { document: { storage: () => storage } },
		policy: { document: false },
	})
	await host.start()
	const admitted = new AbortController()
	const waiting = new AbortController()
	const first = host.config.patch(node, { set: { title: 'Accepted' } }, { signal: admitted.signal })
	try {
		await writing.promise
		const second = host.config.patch(
			node,
			{ set: { title: 'Canceled' } },
			{ signal: waiting.signal },
		)
		const cancelled = second.catch((error: unknown) => error)
		const reason = new Error('Editor closed')
		waiting.abort(reason)
		admitted.abort()
		release.resolve()
		expect(await cancelled).toBe(reason)
		await expect(first).resolves.toMatchObject({ ok: true, application: 'applied' })
		expect(adopted.get('default')).toBe('Accepted')
	} finally {
		release.resolve()
	}
})
