import * as nativeFs from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, PluginPart } from '@pluxel/core'
import { createCoreTestHost, definePluginFork, getCoreTestHostContext } from '../src/internal-test'
import { createStore, type Store } from 'tinybase'
import { createQueries } from 'tinybase/queries'
import * as v from 'valibot'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemory, Passthrough } from '../src/fs'
import { requireHostDocuments, requireTinyBaseHost } from '../src/internal/storage'
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
		return this.ctx.tinybase.open()
	}
	files() {
		return this.ctx.fs()
	}
}
const StateConfig = v.object({
	fail: v.optional(v.boolean(), false),
	flushInInit: v.optional(v.boolean(), false),
})
@Plugin({ forkable: true })
class StateOwner extends BasePlugin {
	private readonly config = this.configs.use(StateConfig)
	readonly state = this.ctx.tinybase
	readonly part = this.parts.use(StatePart)
	store!: Store
	async handles() {
		return {
			state: this.ctx.tinybase,
			directory: await this.ctx.fs(),
			node: this.ctx.pluginInfo.nodeAddress,
			caller: this.ctx.caller?.pluginInfo?.nodeAddress,
		}
	}
	protected override async init(): Promise<void> {
		this.store = await this.state.open(createStore().setValues({ seed: 'first' }))
		if (this.config.flushInInit) await this.state.flush()
		if (this.config.fail) throw new Error('init rejected')
	}
}

@Plugin()
class StateCaller extends BasePlugin {
	constructor(readonly provider: StateOwner) {
		super()
	}
}

@Plugin()
class UnusedOwner extends BasePlugin {}

@Plugin()
class SchemaOwner extends BasePlugin {
	protected override async init(): Promise<void> {
		await this.ctx.tinybase.open(
			createStore().setValuesSchema({
				known: { type: 'string', default: 'new default' },
			}),
		)
	}
}

const nodeFile = (prefix: string) =>
	join(prefix, 'services/tinybase/nodes', `${pluginNodePhysicalKey(StateOwner.nodeAddress())}.json`)
const storage = (prefix: string) => ({
	mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
})

describe('Core-managed native TinyBase', () => {
	it('keeps fixed capabilities on the provider generation through Parts, forks and dependency calls', async () => {
		await using host = createCoreTestHost()
		const east = definePluginFork(StateOwner, 'east-owner')
		await host.commit((change) => {
			change.add([StateOwner, east, StateCaller])
			change.dependencies.setOverride({
				consumer: StateCaller,
				requirement: StateOwner,
				provider: east,
			})
		})
		const provider = host.require(east)
		const caller = host.require(StateCaller)
		const direct = await provider.handles()
		const forwarded = await caller.provider.handles()
		expect(forwarded.state).toBe(direct.state)
		expect(forwarded.directory).toBe(direct.directory)
		expect(forwarded.node).toEqual(provider.ctx.pluginInfo.nodeAddress)
		expect(forwarded.caller).toEqual(caller.ctx.pluginInfo.nodeAddress)
		expect(await provider.part.files()).toBe(direct.directory)
		expect(await provider.part.open()).toBe(provider.store)
		expect(direct.state).not.toBe(host.require(StateOwner).state)
		const defaultHandles = await host.require(StateOwner).handles()
		expect(direct.directory).not.toBe(defaultHandles.directory)
	})

	it('preserves the native instance and Queries; Parts share one recovery and forks isolate data', async () => {
		const prefix = await directory()
		const east = definePluginFork(StateOwner, 'east')
		await using host = await createCoreTestHost({ zenfs: storage(prefix) })
		const owner = await host.add(StateOwner)
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
		await host.add(east)
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
			await using host = await createCoreTestHost({ zenfs: storage(prefix) })
			const owner = await host.add(StateOwner)
			owner.store.setContent([{}, {}])
			await owner.state.flush()
		}
		{
			await using host = await createCoreTestHost({ zenfs: storage(prefix) })
			const owner = await host.add(StateOwner)
			expect(owner.store.getContent()).toEqual([{}, {}])
		}
	})

	it('does not autosave a failed init; explicit init flush commits without waiting for publication', async () => {
		const prefix = await directory()
		{
			await using host = await createCoreTestHost({ zenfs: storage(prefix) })
			await host.commitExpectFail((change) =>
				change.add(StateOwner, { initialConfig: { fail: true } }),
			)
			await expect(stat(nodeFile(prefix))).rejects.toMatchObject({ code: 'ENOENT' })
		}
		{
			await using host = await createCoreTestHost({ zenfs: storage(prefix) })
			await host.commitExpectFail((change) =>
				change.add(StateOwner, { initialConfig: { fail: true, flushInInit: true } }),
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
				identity: { kind: 'plugin', node: StateOwner.nodeAddress() },
				content: [{}, {}],
			}),
			encodeSnapshot(
				{
					kind: 'plugin',
					node: { ...StateOwner.nodeAddress(), variant: 'fork', forkId: 'other' },
				},
				[{}, {}],
				8 * 1024 * 1024,
			),
		]) {
			await writeFile(nodeFile(prefix), text)
			await using host = await createCoreTestHost({ zenfs: storage(prefix) })
			await host.commitExpectFail((change) => change.add(StateOwner))
			expect(await readFile(nodeFile(prefix), 'utf8')).toBe(text)
		}
	})

	it('preserves a snapshot that the supplied native schema would discard or default', async () => {
		const prefix = await directory()
		const identity = { kind: 'plugin' as const, node: SchemaOwner.nodeAddress() }
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
			await using host = await createCoreTestHost({ zenfs: storage(prefix) })
			await host.commitExpectFail((change) => change.add(SchemaOwner))
			expect(await readFile(file, 'utf8')).toBe(text)
		}
	})

	it('rejects an unfinished transaction at flush and never saves a partial native transaction', async () => {
		const prefix = await directory()
		await using host = await createCoreTestHost({ zenfs: storage(prefix) })
		const owner = await host.add(StateOwner)
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
		await using host = await createCoreTestHost({ zenfs: storage(prefix) })
		const owner = await host.add(StateOwner)
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
		await using host = await createCoreTestHost({
			zenfs: { mounts: { '/': { backend: Passthrough, fs: native, prefix } } },
		})
		const owner = await host.add(StateOwner)
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
		const host = await createCoreTestHost({
			zenfs: { mounts: { '/': { backend: Passthrough, fs: native, prefix } } },
		})
		const owner = await host.add(StateOwner)
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

	it('opens Plugin state and writes Host documents despite an unrelated readonly mount', async () => {
		const prefix = await directory()
		await using host = createCoreTestHost({
			zenfs: {
				mounts: {
					'/': InMemory,
					'/assets': { backend: Passthrough, fs: nativeFs, prefix, readOnly: true },
				},
			},
		})
		const owner = await host.add(StateOwner)
		owner.store.setValue('title', 'saved')
		await owner.state.flush()
		const documents = requireHostDocuments(getCoreTestHostContext(host), 'config')
		await documents.put('config.json', 'saved config')
		expect(await documents.getText('config.json')).toBe('saved config')
	})

	it('refuses writable open on a readonly Host while allowing Host document reads', async () => {
		const prefix = await directory()
		{
			const host = await createCoreTestHost({ zenfs: storage(prefix) })
			try {
				await requireHostDocuments(getCoreTestHostContext(host), 'config').put('a', 'confirmed')
			} finally {
				await host.dispose()
			}
		}
		const host = await createCoreTestHost({
			zenfs: { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix, readOnly: true } } },
		})
		try {
			const documents = requireHostDocuments(getCoreTestHostContext(host), 'config')
			expect(await documents.getText('a')).toBe('confirmed')
			await expect(documents.put('a', 'next')).rejects.toMatchObject({ code: 'EROFS' })
		} finally {
			await host.dispose()
		}
		await using readonly = await createCoreTestHost({
			zenfs: { mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix, readOnly: true } } },
		})
		await readonly.commitExpectFail((change) => change.add(StateOwner))
	})

	it('serializes complete Host document updates and publishes only confirmed candidates', async () => {
		const prefix = await directory()
		const host = await createCoreTestHost({ zenfs: storage(prefix) })
		try {
			const documents = requireHostDocuments(getCoreTestHostContext(host), 'config')
			await Promise.all([documents.put('a', 'one'), documents.put('b', 'two')])
			expect(await documents.getText('a')).toBe('one')
			expect(await documents.getText('b')).toBe('two')
		} finally {
			await host.dispose()
		}
		const reopened = await createCoreTestHost({ zenfs: storage(prefix) })
		try {
			const documents = requireHostDocuments(getCoreTestHostContext(reopened), 'config')
			expect(await documents.getText('a')).toBe('one')
			expect(await documents.getText('b')).toBe('two')
		} finally {
			await reopened.dispose()
		}
	})

	it('rejects non-finite/non-scalar Content and preserves format version across round trips', () => {
		const identity = { kind: 'plugin', node: StateOwner.nodeAddress() } as const
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

	it('uses the fixed InMemory default and allocates no Store for plugins that never open', async () => {
		const host = createCoreTestHost()
		try {
			const unused = await host.add(UnusedOwner)
			expect(unused.ctx.fs).toBeTypeOf('function')
			expect(unused.ctx.tinybase).toBeDefined()
			expect(requireTinyBaseHost(getCoreTestHostContext(host)).status()).toEqual([])
		} finally {
			await host.dispose()
		}
	})
})
