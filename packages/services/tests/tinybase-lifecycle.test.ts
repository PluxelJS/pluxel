import * as nativeFs from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/host'
import { definePluginFork } from '@pluxel/test'
import { createMergeableStore, createStore, type Store } from 'tinybase'
import { createCustomPersister } from 'tinybase/persisters'
import { createQueries } from 'tinybase/queries'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fs, InMemory, Passthrough } from '../src/fs'
import { pluginNodePhysicalKey } from '../src/internal/plugin-address'
import { createServiceInternalTestHost } from '../src/testing/service-host'
import { tinybase, TinyBase, TinyBaseHost } from '../src/tinybase'
import { encodeSnapshot } from '../src/tinybase/codec'

vi.mock('tinybase', async (importOriginal) => {
	const actual = await importOriginal<typeof import('tinybase')>()
	return { ...actual, createStore: vi.fn(actual.createStore) }
})

@Plugin({ forkable: true })
class HandleOwner extends BasePlugin {
	readonly state = this.ctx.require(TinyBase)
	admission() {
		return enterOwnerInvocation(this.ctx)
	}
}

@Plugin()
class LazyOwner extends BasePlugin {
	state() {
		return this.ctx.require(TinyBase)
	}
}

const directories: string[] = []
beforeEach(() => {
	vi.mocked(createStore).mockClear()
})
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function directory(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'pluxel-tinybase-lifecycle-'))
	directories.push(path)
	return path
}

function nodeFile(prefix: string, owner: typeof HandleOwner | typeof LazyOwner): string {
	return join(
		prefix,
		'services/tinybase/nodes',
		`${pluginNodePhysicalKey(pluginNodeAddressOf(owner))}.json`,
	)
}

describe('TinyBase native Store admission and generation lifetime', () => {
	it('rejects an explicit null snapshot budget while accepting omitted or undefined budgets', () => {
		// Exercise invalid JavaScript input without widening the public contract.
		expect(() => tinybase({ maxSnapshotBytes: null } as never)).toThrow(
			'maxSnapshotBytes must be a positive safe integer',
		)
		expect(() => tinybase()).not.toThrow()
		expect(() => tinybase({ maxSnapshotBytes: undefined })).not.toThrow()
		expect(createStore).not.toHaveBeenCalled()
	})

	it.each([null, false, 0, '', {}, [], () => {}] as const)(
		'rejects an explicitly invalid Store input %j without selecting the default Store',
		async (input) => {
			await using host = await createServiceInternalTestHost({
				services: [fs({ backend: InMemory }), tinybase()],
			})
			const owner = await host.start(HandleOwner)
			// @ts-expect-error Deliberately exercise invalid JavaScript callers without widening the public contract.
			await expect(owner.state.open(input)).rejects.toMatchObject({ code: 'INVALID_STORE' })
			expect(createStore).not.toHaveBeenCalled()
			expect(host.ctx.require(TinyBaseHost).status()).toEqual([])
			await owner.state.open()
			await owner.state.flush()
		},
	)

	it.each(['listener', 'queries', 'persister', 'transaction', 'mergeable'] as const)(
		'rejects an already attached %s before claiming the Store or restoring data',
		async (attachment) => {
			await using host = await createServiceInternalTestHost({
				services: [fs({ backend: InMemory }), tinybase()],
			})
			const owner = await host.start(HandleOwner)
			const store = attachment === 'mergeable' ? createMergeableStore() : createStore()
			let cleanup: () => void | Promise<void> = () => {}
			if (attachment === 'listener') {
				const listener = store.addValueListener('value', () => {})
				cleanup = () => {
					store.delListener(listener)
				}
			} else if (attachment === 'queries') {
				const queries = createQueries(store).setQueryDefinition('all', 'items', ({ select }) =>
					select('value'),
				)
				cleanup = () => {
					queries.destroy()
				}
			} else if (attachment === 'persister') {
				const persister = createCustomPersister(
					store,
					async (): Promise<undefined> => undefined,
					async (): Promise<void> => {},
					(): undefined => undefined,
					() => {},
				)
				await persister.startAutoSave()
				cleanup = async () => {
					await persister.destroy()
				}
			} else if (attachment === 'transaction') {
				store.startTransaction().setValue('partial', 'uncommitted')
				cleanup = () => {
					store.finishTransaction()
				}
			}
			try {
				await expect(owner.state.open(store)).rejects.toMatchObject({
					code: attachment === 'transaction' ? 'TRANSACTION_ACTIVE' : 'INVALID_STORE',
				})
				expect(host.ctx.require(TinyBaseHost).status()).toEqual([])
			} finally {
				await cleanup()
			}
			// Invalid admission must not poison a Store that becomes fresh after explicit cleanup.
			const fresh = attachment === 'mergeable' ? createStore() : store
			await expect(owner.state.open(fresh)).resolves.toBe(fresh)
			await owner.state.flush()
		},
	)

	it("refuses a current or retired generation's Store even after its listeners are removed", async () => {
		await using host = await createServiceInternalTestHost({
			services: [fs({ backend: InMemory }), tinybase()],
		})
		const owner = await host.start(HandleOwner)
		const store = createStore()
		await owner.state.open(store)
		const fork = definePluginFork(HandleOwner, 'other')
		const other = await host.start(fork)
		await expect(other.state.open(store)).rejects.toMatchObject({ code: 'STORE_IN_USE' })
		await host.stop(HandleOwner)
		expect(Object.values(store.getListenerStats()).every((count) => count === 0)).toBe(true)
		const replacement = await host.start(HandleOwner)
		await expect(replacement.state.open(store)).rejects.toMatchObject({ code: 'STORE_IN_USE' })
		await replacement.state.open()
		await replacement.state.flush()
	})

	it('borrows TinyBase without creating a native Store or allocating a writer before open', async () => {
		const prefix = await directory()
		await using host = await createServiceInternalTestHost({
			services: [fs({ backend: Passthrough, fs: nativeFs, prefix }), tinybase()],
		})
		const owner = await host.start(HandleOwner)
		expect(owner.state).toBeDefined()
		expect(createStore).not.toHaveBeenCalled()
		expect(host.ctx.require(TinyBaseHost).status()).toEqual([])
		await expect(stat(nodeFile(prefix, HandleOwner))).rejects.toMatchObject({ code: 'ENOENT' })
		await host.stop(HandleOwner)
		expect(createStore).not.toHaveBeenCalled()
		expect(host.ctx.require(TinyBaseHost).status()).toEqual([])
	})

	it.each(['existing', 'late'] as const)(
		'automatically saves lazy open after publication with an %s service handle',
		async (handle) => {
			const prefix = await directory()
			const ownerClass = handle === 'existing' ? HandleOwner : LazyOwner
			const file = nodeFile(prefix, ownerClass)
			const initial = Promise.withResolvers<void>()
			const updated = Promise.withResolvers<void>()
			let writes = 0
			const native = {
				...nativeFs,
				promises: {
					...nativeFs.promises,
					async rename(...args: Parameters<typeof nativeFs.promises.rename>) {
						await nativeFs.promises.rename(...args)
						if (String(args[1]) === file) {
							writes++
							if (writes === 1) initial.resolve()
							else updated.resolve()
						}
					},
				},
			}
			await using host = await createServiceInternalTestHost({
				services: [fs({ backend: Passthrough, fs: native, prefix }), tinybase()],
			})
			const owner = await host.start(ownerClass)
			expect(host.ctx.require(TinyBaseHost).status()).toEqual([])
			const state = owner instanceof HandleOwner ? owner.state : owner.state()
			const store = createStore().setValue('value', 'initial')
			await expect(state.open(store)).resolves.toBe(store)
			await initial.promise
			expect(JSON.parse(await readFile(file, 'utf8')).content[1]).toEqual({ value: 'initial' })
			store.setValue('value', 'updated')
			await updated.promise
			expect(JSON.parse(await readFile(file, 'utf8')).content[1]).toEqual({ value: 'updated' })
		},
	)

	it.each([
		['Plugin', 'existing'],
		['Host', 'existing'],
		['Plugin', 'missing'],
		['Host', 'missing'],
	] as const)(
		'drains accepted restoration on %s stop with %s backing, rejects late results and detaches the retired Store',
		async (target, backing) => {
			const prefix = await directory()
			const file = nodeFile(prefix, HandleOwner)
			const text = encodeSnapshot(
				{ kind: 'plugin', node: pluginNodeAddressOf(HandleOwner) },
				[{}, { value: 'confirmed' }],
				10000,
			)
			await mkdir(dirname(file), { recursive: true })
			if (backing === 'existing') await writeFile(file, text)
			const entered = Promise.withResolvers<void>()
			const release = Promise.withResolvers<void>()
			const native = {
				...nativeFs,
				promises: {
					...nativeFs.promises,
					stat: new Proxy(nativeFs.promises.stat, {
						async apply(operation, receiver, args): ReturnType<typeof nativeFs.promises.stat> {
							if (String(args[0]) === file) {
								entered.resolve()
								await release.promise
							}
							return Reflect.apply(operation, receiver, args)
						},
					}),
				},
			}
			await using host = await createServiceInternalTestHost({
				services: [fs({ backend: Passthrough, fs: native, prefix }), tinybase()],
			})
			const owner = await host.start(HandleOwner)
			const store: Store = createStore().setValue('seed', 'unpublished candidate')
			const opening = owner.state.open(store)
			void opening.catch(() => {})
			let stopping: Promise<void> | undefined
			const admission = target === 'Plugin' ? owner.admission() : enterOwnerInvocation(host.ctx)
			const closed = Promise.withResolvers<void>()
			admission.signal.addEventListener(
				'abort',
				() => {
					closed.resolve()
				},
				{ once: true },
			)
			try {
				await entered.promise
				let stopped = false
				stopping = target === 'Plugin' ? host.stop(HandleOwner) : host.dispose()
				void stopping.then((): undefined => {
					stopped = true
					return undefined
				})
				await closed.promise
				admission.dispose()
				await expect(owner.state.open()).rejects.toThrow('Plugin owner stopped')
				await expect(owner.state.flush()).rejects.toThrow('Plugin owner stopped')
				expect(stopped).toBe(false)
				release.resolve()
				await expect(opening).rejects.toThrow('Plugin owner stopped')
				await stopping
				expect(Object.values(store.getListenerStats()).every((count) => count === 0)).toBe(true)
				store.setValue('stale', 'must not save')
				const persisted = await readFile(file, 'utf8').catch((error: unknown): undefined => {
					if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
					throw error
				})
				expect(persisted).toBe(backing === 'existing' ? text : undefined)
				await host.dispose()
				await using reopened = await createServiceInternalTestHost({
					services: [fs({ backend: Passthrough, fs: nativeFs, prefix }), tinybase()],
				})
				const replacement = await reopened.start(HandleOwner)
				const restored = await replacement.state.open()
				expect(restored.getValue('value')).toBe(backing === 'existing' ? 'confirmed' : undefined)
				expect(restored.getValue('seed')).toBeUndefined()
				expect(restored.getValue('stale')).toBeUndefined()
			} finally {
				admission.dispose()
				release.resolve()
				await opening.catch(() => {})
				await stopping
			}
		},
	)
})
