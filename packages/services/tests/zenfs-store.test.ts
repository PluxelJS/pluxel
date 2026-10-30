import {
	bindContext,
	configureFileSystem,
	InMemoryStore,
	StoreFS,
	SyncTransaction,
	vfs,
	type BoundContext,
	type Store,
} from '@zenfs/core'
import { afterEach, describe, expect, it } from 'vitest'

const encode = (text: string) => new TextEncoder().encode(text)
const contexts: BoundContext[] = []

afterEach(async () => {
	const results = await Promise.allSettled(
		contexts.splice(0).map(async (context) => {
			try {
				await context.dispose()
			} finally {
				await vfs.umountAsync.call(context, '/')
			}
		}),
	)
	const failures = results
		.filter((result) => result.status === 'rejected')
		.map((result) => result.reason)
	if (failures.length > 0)
		throw new AggregateError(failures, 'Failed to release ZenFS test contexts')
})

async function fixture() {
	const store = new InMemoryStore()
	const backing = new StoreFS(store)
	await backing.ready()
	for (const [path, text] of [
		['/old', 'OLD-CONTENT'],
		['/temporary', 'NEW-CONTENT'],
	] as const) {
		await backing.createFile(path, { mode: 0o600, uid: 0, gid: 0 })
		await backing.write(path, encode(text), 0)
	}
	return { store, backing }
}

function snapshot(store: InMemoryStore) {
	return [...store]
		.map(([id, bytes]) => [id, Buffer.from(bytes).toString('hex')] as const)
		.sort(([left], [right]) => left - right)
}

function instrumentMutations(store: InMemoryStore, visit: (apply: () => void) => void) {
	const set = store.set.bind(store)
	const remove = store.delete.bind(store)
	store.set = (id, bytes) => {
		visit(() => set(id, bytes))
		return store
	}
	store.delete = (id) => {
		let removed = false
		visit(() => {
			removed = remove(id)
		})
		return removed
	}
}

async function expectOriginal(backing: StoreFS) {
	const entries = await backing.readdir('/')
	expect(entries.sort()).toEqual(['old', 'temporary'])
	for (const [path, text] of [
		['/old', 'OLD-CONTENT'],
		['/temporary', 'NEW-CONTENT'],
	] as const) {
		const inode = await backing.stat(path)
		const bytes = new Uint8Array(inode.size)
		await backing.read(path, bytes, 0, bytes.byteLength)
		expect(new TextDecoder().decode(bytes)).toBe(text)
	}
}

const operations = [
	{ name: 'create', run: (fs: StoreFS) => fs.createFile('/new', { mode: 0o600, uid: 0, gid: 0 }) },
	{ name: 'truncate', run: (fs: StoreFS) => fs.touch('/old', { size: 2 }) },
	{ name: 'write', run: (fs: StoreFS) => fs.write('/old', encode('X'), 3) },
	{ name: 'unlink', run: (fs: StoreFS) => fs.unlink('/old') },
	{ name: 'link', run: (fs: StoreFS) => fs.link('/old', '/new') },
	{ name: 'rename', run: (fs: StoreFS) => fs.rename('/temporary', '/old') },
]

type AsyncEnumerationStore = Store & { data: Map<number, Uint8Array>; writes: number }

class AsyncEnumerationTransaction extends SyncTransaction<AsyncEnumerationStore> {
	async keys() {
		return this.store.data.keys()
	}
	getSync(id: number) {
		return this.store.data.get(id)
	}
	setSync(id: number, bytes: Uint8Array) {
		this.store.writes++
		this.store.data.set(id, bytes)
	}
	removeSync(id: number) {
		this.store.writes++
		this.store.data.delete(id)
	}
}

describe('ZenFS StoreFS dependency admission', () => {
	it.each(['async', 'sync'] as const)(
		'initializes an entirely empty store through %s ready',
		async (mode) => {
			const store = new InMemoryStore()
			const backing = new StoreFS(store)
			expect(store.size).toBe(0)
			if (mode === 'async') await backing.ready()
			else backing.readySync()
			expect(backing.readdirSync('/')).toEqual([])
			expect(store.has(0)).toBe(true)
		},
	)

	it.each([
		{ mode: 'async', orphanOnly: false },
		{ mode: 'sync', orphanOnly: false },
		{ mode: 'async', orphanOnly: true },
		{ mode: 'sync', orphanOnly: true },
	] as const)(
		'rejects $mode initialization when root is missing (only orphan keys: $orphanOnly)',
		async ({ mode, orphanOnly }) => {
			const { store } = orphanOnly ? { store: new InMemoryStore() } : await fixture()
			if (orphanOnly) {
				store.set(2, encode('orphan inode'))
				store.set(3, encode('orphan data'))
			} else store.delete(0)
			const before = snapshot(store)
			const reopened = new StoreFS(store)
			const ready = mode === 'async' ? () => reopened.ready() : () => reopened.readySync()
			await expect(Promise.resolve().then(ready)).rejects.toMatchObject({ code: 'EIO' })
			expect(snapshot(store)).toEqual(before)
		},
	)

	it.each(['async', 'sync'] as const)(
		'keeps readonly missing roots as ENOENT through %s ready',
		async (mode) => {
			const { store } = await fixture()
			store.delete(0)
			const before = snapshot(store)
			const reopened = new StoreFS(store)
			configureFileSystem(reopened, { readOnly: true })
			const ready = mode === 'async' ? () => reopened.ready() : () => reopened.readySync()
			await expect(Promise.resolve().then(ready)).rejects.toMatchObject({ code: 'ENOENT' })
			expect(snapshot(store)).toEqual(before)
		},
	)

	it('refuses synchronous initialization without synchronous key enumeration before writing', () => {
		const store: AsyncEnumerationStore = {
			name: 'async-enumeration-only',
			data: new Map(),
			writes: 0,
			async sync() {},
			transaction() {
				return new AsyncEnumerationTransaction(this)
			},
		}
		const backing = new StoreFS(store)
		expect(() => backing.readySync()).toThrow(expect.objectContaining({ code: 'EAGAIN' }))
		expect(store.writes).toBe(0)
		expect(store.data.size).toBe(0)
	})

	it.each(operations)(
		'restores bytes and indexes when $name fails at a store mutation',
		async ({ run }) => {
			const control = await fixture()
			let mutations = 0
			instrumentMutations(control.store, (apply) => {
				mutations++
				apply()
			})
			await run(control.backing)
			expect(mutations).toBeGreaterThan(0)

			// Discover mutation points from the successful operation rather than fixing an
			// implementation-specific request count. The pinned dependency exercises 32 failures.
			for (let failingStep = 1; failingStep <= mutations; failingStep++) {
				for (const timing of ['before', 'after'] as const) {
					const { store, backing } = await fixture()
					const before = snapshot(store)
					const failure = new Error(`Store mutation ${failingStep} failed ${timing} applying`)
					let step = 0
					instrumentMutations(store, (apply) => {
						const injected = ++step === failingStep
						if (injected && timing === 'before') throw failure
						apply()
						if (injected && timing === 'after') throw failure
					})

					await expect(run(backing)).rejects.toBe(failure)
					expect(snapshot(store)).toEqual(before)
					await expectOriginal(backing)
					const reopened = new StoreFS(store)
					await reopened.ready()
					await expectOriginal(reopened)
				}
			}
		},
	)

	it('preserves concurrent files and owner directories through the public promises API', async () => {
		const store = new InMemoryStore()
		const backing = new StoreFS(store)
		await backing.ready()
		const root = bindContext({ root: '/', pwd: '/', mounts: { '/': backing } })
		contexts.push(root)
		const fs = root.fs.promises
		await Promise.all([fs.writeFile('a', 'A'), fs.writeFile('b', 'B')])
		await fs.mkdir('plugins')
		await Promise.all([fs.mkdir('plugins/one'), fs.mkdir('plugins/two')])
		const first = root.bind({ root: '/plugins/one', pwd: '/' }).fs.promises
		const second = root.bind({ root: '/plugins/two', pwd: '/' }).fs.promises
		await Promise.all([first.writeFile('a', 'OWNER-A'), second.writeFile('b', 'OWNER-B')])
		const rootEntries = await fs.readdir('/')
		const ownerEntries = await fs.readdir('plugins')
		expect(rootEntries.sort()).toEqual(['a', 'b', 'plugins'])
		expect(ownerEntries.sort()).toEqual(['one', 'two'])
		expect(await first.readFile('a', 'utf8')).toBe('OWNER-A')
		expect(await second.readFile('b', 'utf8')).toBe('OWNER-B')

		const reopened = new StoreFS(store)
		await reopened.ready()
		const view = bindContext({ root: '/', pwd: '/', mounts: { '/': reopened } })
		contexts.push(view)
		const reopenedEntries = await view.fs.promises.readdir('/')
		const reopenedOwners = await view.fs.promises.readdir('plugins')
		expect(reopenedEntries.sort()).toEqual(['a', 'b', 'plugins'])
		expect(reopenedOwners.sort()).toEqual(['one', 'two'])
		expect(await view.fs.promises.readFile('/plugins/one/a', 'utf8')).toBe('OWNER-A')
		expect(await view.fs.promises.readFile('/plugins/two/b', 'utf8')).toBe('OWNER-B')
	})
})
