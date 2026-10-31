import * as nativeFs from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, PluginPart, pluginNodeAddressOf } from '@pluxel/core'
import { createHost } from '@pluxel/host'
import { createTestHost, definePluginFork } from '@pluxel/test'
import { createStore, type Store } from 'tinybase'
import { createQueries } from 'tinybase/queries'
import * as v from 'valibot'
import { afterEach, describe, expect, it } from 'vitest'
import { fs, Passthrough, InMemory } from '../src/fs'
import { tinybase, TinyBase, TinyBaseHost } from '../src/tinybase'
import { pluginNodePhysicalKey } from '../src/internal/plugin-address'
import { encodeSnapshot, decodeSnapshot } from '../src/tinybase/codec'

const directories: string[] = []
async function directory(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), 'pluxel-tinybase-'))
	directories.push(value)
	return value
}
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
	)
})

class StatePart extends PluginPart<StateOwner> {
	open() {
		return this.ctx.require(TinyBase).open()
	}
}
const StateConfig = v.object({
	fail: v.optional(v.boolean(), false),
	flushInInit: v.optional(v.boolean(), false),
})
@Plugin({ forkable: true })
class StateOwner extends BasePlugin {
	private readonly config = this.configs.use(StateConfig)
	readonly state = this.ctx.require(TinyBase)
	readonly part = this.parts.use(StatePart)
	store!: Store
	protected override async init(): Promise<void> {
		this.store = await this.state.open(createStore().setValues({ seed: 'first' }))
		if (this.config.flushInInit) await this.state.flush()
		if (this.config.fail) throw new Error('init rejected')
	}
}

@Plugin()
class SchemaOwner extends BasePlugin {
	protected override async init(): Promise<void> {
		await this.ctx.require(TinyBase).open(
			createStore().setValuesSchema({
				known: { type: 'string', default: 'new default' },
			}),
		)
	}
}

const nodeFile = (prefix: string) =>
	join(
		prefix,
		'services/tinybase/nodes',
		`${pluginNodePhysicalKey(pluginNodeAddressOf(StateOwner))}.json`,
	)
const services = (prefix: string) => [
	fs({ backend: Passthrough, fs: nativeFs, prefix }),
	tinybase(),
]

describe('Host-managed native TinyBase', () => {
	it('preserves the native instance and Queries; Parts share one recovery and forks isolate data', async () => {
		const prefix = await directory()
		const east = definePluginFork(StateOwner, 'east')
		await using host = await createTestHost({ services: services(prefix) })
		const owner = await host.start(StateOwner)
		expect(await owner.state.open(owner.store)).toBe(owner.store)
		expect(await owner.part.open()).toBe(owner.store)
		const opened = await Promise.all([owner.state.open(), owner.state.open()])
		expect(opened).toEqual([owner.store, owner.store])
		await expect(owner.state.open(createStore())).rejects.toMatchObject({ code: 'OPEN_CONFLICT' })
		owner.store.setRow('items', 'a', { value: 4 })
		const queries = createQueries(owner.store).setQueryDefinition('all', 'items', ({ select }) =>
			select('value'),
		)
		try {
			expect(queries.getResultRow('all', 'a')).toEqual({ value: 4 })
		} finally {
			queries.destroy()
		}
		await owner.state.flush()
		await host.start(east)
		expect(host.require(east).store.getRowIds('items')).toEqual([])
		await host.restart(StateOwner)
		expect(host.require(StateOwner).store.getCell('items', 'a', 'value')).toBe(4)
		await expect(owner.state.flush()).rejects.toThrow(Error)
		owner.store.setValue('stale', 'must not persist')
		await host.require(StateOwner).state.flush()
		expect(await readFile(nodeFile(prefix), 'utf8')).not.toContain('must not persist')
	})

	it('restores confirmed data across Hosts, including a deliberately empty Store', async () => {
		const prefix = await directory()
		{
			await using host = await createTestHost({ services: services(prefix) })
			const owner = await host.start(StateOwner)
			owner.store.setContent([{}, {}])
			await owner.state.flush()
		}
		{
			await using host = await createTestHost({ services: services(prefix) })
			const owner = await host.start(StateOwner)
			expect(owner.store.getContent()).toEqual([{}, {}])
		}
	})

	it('does not autosave a failed init; explicit init flush commits without waiting for publication', async () => {
		const prefix = await directory()
		{
			await using host = await createTestHost({ services: services(prefix) })
			await host.commitExpectFail((change) =>
				change.start(StateOwner, { initialConfig: { fail: true } }),
			)
			await expect(stat(nodeFile(prefix))).rejects.toMatchObject({ code: 'ENOENT' })
		}
		{
			await using host = await createTestHost({ services: services(prefix) })
			await host.commitExpectFail((change) =>
				change.start(StateOwner, { initialConfig: { fail: true, flushInInit: true } }),
			)
			expect(JSON.parse(await readFile(nodeFile(prefix), 'utf8')).content).toEqual([
				{},
				{ seed: 'first' },
			])
		}
	})

	it('refuses corrupt, future and wrong-owner snapshots without overwriting them', async () => {
		const prefix = await directory()
		await mkdir(join(prefix, 'services/tinybase/nodes'), { recursive: true })
		for (const text of [
			'{broken',
			JSON.stringify({
				format: 'pluxel.tinybase',
				formatVersion: 999,
				identity: { kind: 'plugin', node: pluginNodeAddressOf(StateOwner) },
				content: [{}, {}],
			}),
			encodeSnapshot(
				{
					kind: 'plugin',
					node: { ...pluginNodeAddressOf(StateOwner), variant: 'fork', forkId: 'other' },
				},
				[{}, {}],
				8 * 1024 * 1024,
			),
		]) {
			await writeFile(nodeFile(prefix), text)
			await using host = await createTestHost({ services: services(prefix) })
			await host.commitExpectFail((change) => change.start(StateOwner))
			expect(await readFile(nodeFile(prefix), 'utf8')).toBe(text)
		}
	})

	it('preserves a snapshot that the supplied native schema would discard or default', async () => {
		const prefix = await directory()
		const identity = { kind: 'plugin' as const, node: pluginNodeAddressOf(SchemaOwner) }
		const file = join(
			prefix,
			'services/tinybase/nodes',
			`${pluginNodePhysicalKey(identity.node)}.json`,
		)
		await mkdir(join(prefix, 'services/tinybase/nodes'), { recursive: true })
		for (const content of [
			[{}, { unknown: 'retained' }],
			[{}, {}],
		] as const) {
			const text = encodeSnapshot(identity, [content[0], content[1]], 8 * 1024 * 1024)
			await writeFile(file, text)
			await using host = await createTestHost({ services: services(prefix) })
			await host.commitExpectFail((change) => change.start(SchemaOwner))
			expect(await readFile(file, 'utf8')).toBe(text)
		}
	})

	it('rejects an unfinished transaction at flush and never saves a partial native transaction', async () => {
		const prefix = await directory()
		await using host = await createTestHost({ services: services(prefix) })
		const owner = await host.start(StateOwner)
		await owner.state.flush()
		owner.store.startTransaction().setValue('partial', true)
		await expect(owner.state.flush()).rejects.toMatchObject({ code: 'TRANSACTION_ACTIVE' })
		expect(await readFile(nodeFile(prefix), 'utf8')).not.toContain('partial')
		owner.store.finishTransaction()
		await owner.state.flush()
		expect(JSON.parse(await readFile(nodeFile(prefix), 'utf8')).content[1].partial).toBe(true)
	})

	it('captures a ready flush before a transaction starts later in the same tick', async () => {
		const prefix = await directory()
		await using host = await createTestHost({ services: services(prefix) })
		const owner = await host.start(StateOwner)
		await owner.state.flush()
		owner.store.setValue('complete', 1)
		const confirmed = owner.state.flush()
		owner.store.startTransaction().setValue('partial', true)
		try {
			await confirmed
			const content = JSON.parse(await readFile(nodeFile(prefix), 'utf8')).content[1]
			expect(content.complete).toBe(1)
			expect(content).not.toHaveProperty('partial')
		} finally {
			owner.store.finishTransaction()
		}
	})

	it('settles flush at its captured revision while later transactions remain in flight', async () => {
		const prefix = await directory()
		const firstEntered = Promise.withResolvers<void>()
		const secondEntered = Promise.withResolvers<void>()
		const firstRelease = Promise.withResolvers<void>()
		const secondRelease = Promise.withResolvers<void>()
		let gate = false
		let writes = 0
		const native = {
			...nativeFs,
			promises: {
				...nativeFs.promises,
				async rename(
					from: Parameters<typeof nativeFs.promises.rename>[0],
					to: Parameters<typeof nativeFs.promises.rename>[1],
				) {
					if (gate && String(to).includes('/tinybase/nodes/')) {
						writes++
						if (writes === 1) {
							firstEntered.resolve()
							await firstRelease.promise
						}
						if (writes === 2) {
							secondEntered.resolve()
							await secondRelease.promise
						}
					}
					return nativeFs.promises.rename(from, to)
				},
			},
		}
		await using host = await createTestHost({
			services: [fs({ backend: Passthrough, fs: native, prefix }), tinybase()],
		})
		const owner = await host.start(StateOwner)
		await owner.state.flush()
		try {
			gate = true
			owner.store.setValue('progress', 1)
			const first = owner.state.flush()
			owner.store.setValue('progress', 2)
			const second = owner.state.flush()
			await firstEntered.promise
			firstRelease.resolve()
			await first
			await secondEntered.promise
			expect(JSON.parse(await readFile(nodeFile(prefix), 'utf8')).content[1].progress).toBe(1)
			secondRelease.resolve()
			await second
			expect(JSON.parse(await readFile(nodeFile(prefix), 'utf8')).content[1].progress).toBe(2)
		} finally {
			firstRelease.resolve()
			secondRelease.resolve()
		}
	})

	it('reports a save fault, rejects subsequent flush, and never retries during shutdown', async () => {
		const prefix = await directory()
		let fail = false
		let attempts = 0
		const native = {
			...nativeFs,
			promises: {
				...nativeFs.promises,
				async rename(
					from: Parameters<typeof nativeFs.promises.rename>[0],
					to: Parameters<typeof nativeFs.promises.rename>[1],
				) {
					if (fail && String(to).includes('/tinybase/nodes/')) {
						attempts++
						throw Object.assign(new Error('disk write rejected'), { code: 'EIO' })
					}
					return nativeFs.promises.rename(from, to)
				},
			},
		}
		const host = await createTestHost({
			services: [fs({ backend: Passthrough, fs: native, prefix }), tinybase()],
		})
		const owner = await host.start(StateOwner)
		await owner.state.flush()
		fail = true
		owner.store.setValue('candidate', true)
		await expect(owner.state.flush()).rejects.toMatchObject({ code: 'SAVE_FAILED' })
		expect(owner.store.getValue('candidate')).toBe(true)
		expect(JSON.parse(await readFile(nodeFile(prefix), 'utf8')).content[1]).not.toHaveProperty(
			'candidate',
		)
		await expect(owner.state.flush()).rejects.toMatchObject({ code: 'SAVE_FAILED' })
		await expect(host.dispose()).rejects.toThrow(AggregateError)
		expect(attempts).toBe(1)
	})

	it('keeps the confirmed Host document view on save failure and blocks later candidate writes', async () => {
		const prefix = await directory()
		let fail = false
		let attempts = 0
		const native = {
			...nativeFs,
			promises: {
				...nativeFs.promises,
				async rename(
					from: Parameters<typeof nativeFs.promises.rename>[0],
					to: Parameters<typeof nativeFs.promises.rename>[1],
				) {
					if (fail) {
						attempts++
						throw new Error('document write rejected')
					}
					return nativeFs.promises.rename(from, to)
				},
			},
		}
		const host = await createHost({
			plugins: [],
			services: [fs({ backend: Passthrough, fs: native, prefix }), tinybase()],
		})
		const manager = host.ctx.require(TinyBaseHost)
		const documents = manager.documents('private')
		await documents.put('a', 'confirmed')
		fail = true
		await expect(documents.put('a', 'candidate')).rejects.toMatchObject({ code: 'SAVE_FAILED' })
		expect(await documents.getText('a')).toBe('confirmed')
		await expect(documents.put('b', 'must not leak')).rejects.toMatchObject({ code: 'SAVE_FAILED' })
		expect(await documents.getText('b')).toBeUndefined()
		expect(manager.status()).toMatchObject([
			{ outcome: 'unknown', phase: 'faulted', revision: 1, savedRevision: 1 },
		])
		await expect(host.close()).rejects.toThrow(AggregateError)
		expect(attempts).toBe(1)
	})

	it('refuses writable open on a readonly Host while allowing Host document reads', async () => {
		const prefix = await directory()
		{
			const host = await createHost({ plugins: [], services: services(prefix) })
			try {
				await host.ctx.require(TinyBaseHost).documents('config').put('a', 'confirmed')
			} finally {
				await host.close()
			}
		}
		const host = await createHost({
			plugins: [],
			services: [fs({ backend: Passthrough, fs: nativeFs, prefix, readOnly: true }), tinybase()],
		})
		try {
			const documents = host.ctx.require(TinyBaseHost).documents('config')
			expect(await documents.getText('a')).toBe('confirmed')
			await expect(documents.put('a', 'next')).rejects.toMatchObject({ code: 'EROFS' })
		} finally {
			await host.close()
		}
		await using readonly = await createTestHost({
			services: [fs({ backend: Passthrough, fs: nativeFs, prefix, readOnly: true }), tinybase()],
		})
		await readonly.commitExpectFail((change) => change.start(StateOwner))
	})

	it('serializes complete Host document updates and publishes only confirmed candidates', async () => {
		const prefix = await directory()
		const host = await createHost({ plugins: [], services: services(prefix) })
		try {
			const documents = host.ctx.require(TinyBaseHost).documents('config')
			await Promise.all([documents.put('a', 'one'), documents.put('b', 'two')])
			expect(await documents.getText('a')).toBe('one')
			expect(await documents.getText('b')).toBe('two')
		} finally {
			await host.close()
		}
		const reopened = await createHost({ plugins: [], services: services(prefix) })
		try {
			const documents = reopened.ctx.require(TinyBaseHost).documents('config')
			expect(await documents.getText('a')).toBe('one')
			expect(await documents.getText('b')).toBe('two')
		} finally {
			await reopened.close()
		}
	})

	it('rejects non-finite/non-scalar Content and preserves format version across round trips', () => {
		const identity = { kind: 'plugin', node: pluginNodeAddressOf(StateOwner) } as const
		for (const value of [NaN, Infinity, undefined, 2n, {}, new Uint8Array(2)])
			expect(() => encodeSnapshot(identity, [{}, { bad: value }] as never, 10000)).toThrow(
				'finite numbers',
			)
		const content = [{ things: { first: { text: 'value', flag: false, number: -0 } } }, {}] as const
		const text = encodeSnapshot(identity, content as never, 10000)
		expect(JSON.parse(text).formatVersion).toBe(1)
		expect(decodeSnapshot(text, identity, 10000)).toEqual([
			{ things: { first: { text: 'value', flag: false, number: 0 } } },
			{},
		])
		expect(() => decodeSnapshot(text, identity, 10)).toThrow('Snapshot exceeds 10 UTF-8 bytes')
	})

	it('keeps InMemory explicit and allocates no Store for plugins that never open', async () => {
		const host = await createHost({
			plugins: [],
			services: [fs({ backend: InMemory }), tinybase()],
		})
		try {
			expect(host.ctx.require(TinyBaseHost).status()).toEqual([])
		} finally {
			await host.close()
		}
	})
})
