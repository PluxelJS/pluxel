// These probes validate the installed ZenFS dependencies, independently of Pluxel services.
import { bindContext, boundContexts, resolveMountConfig, vfs } from '@zenfs/core'
import { caches } from '@zenfs/core/vfs/vcache.js'
import { IndexedDB } from '@zenfs/dom'

export async function run() {
	const name = `pluxel-admission-${crypto.randomUUID()}`,
		tracking = trackedDatabases(new Set([name]))
	let backing, ctx, reopened, second
	try {
		backing = await resolveMountConfig({ backend: IndexedDB, storeName: name })
		ctx = bindContext({ root: '/', pwd: '/', mounts: { '/': backing } })
		const fs = ctx.fs.promises
		await fs.writeFile('settings.json', 'OLD-CONTENT')
		const afterWrite = tracking.transactions.size
		await fs.writeFile('.tmp.settings.json', 'NEW-CONTENT', { flag: 'wx', mode: 0o600 })
		await fs.rename('.tmp.settings.json', 'settings.json')
		const afterRename = tracking.transactions.size
		const content = await fs.readFile('settings.json', 'utf8')
		await fs.writeFile('empty', 'OLD')
		await fs.writeFile('empty', '')
		const afterEmptyWrite = tracking.transactions.size
		const bytes = Uint8Array.from({ length: 257 }, (_, index) => index)
		await fs.writeFile('binary', bytes)
		const afterBinaryWrite = tracking.transactions.size
		const binary = Array.from(await fs.readFile('binary'))
		reopened = await resolveMountConfig({ backend: IndexedDB, storeName: name })
		second = bindContext({ root: '/', pwd: '/', mounts: { '/': reopened } })
		const reopenedContent = await second.fs.promises.readFile('settings.json', 'utf8')
		const reopenedEmpty = await second.fs.promises.readFile('empty', 'utf8')
		const reopenedBinary = Array.from(await second.fs.promises.readFile('binary'))
		return {
			afterWrite,
			afterRename,
			afterEmptyWrite,
			afterBinaryWrite,
			content,
			reopenedContent,
			binary,
			reopenedEmpty,
			reopenedBinary,
		}
	} finally {
		try {
			await release(reopened, second)
		} finally {
			try {
				await release(backing, ctx)
			} finally {
				await tracking.cleanup()
			}
		}
	}
}

export async function runFailure(kind) {
	const name = `pluxel-failure-${crypto.randomUUID()}`,
		tracking = trackedDatabases(new Set([name]))
	const originalPut = IDBObjectStore.prototype.put
	let backing,
		ctx,
		reopened,
		second,
		injected = false
	const result = { kind }
	try {
		backing = await resolveMountConfig({ backend: IndexedDB, storeName: name })
		ctx = bindContext({ root: '/', pwd: '/', mounts: { '/': backing } })
		const fs = ctx.fs.promises
		await fs.writeFile('settings.json', 'OLD-CONTENT')
		await fs.writeFile('.tmp.settings.json', 'NEW-CONTENT')
		IDBObjectStore.prototype.put = function (...args) {
			if (!injected && this.transaction.db.name === name) {
				injected = true
				if (kind === 'quota') {
					// Exercise the quota error path without filling the browser's shared storage.
					this.transaction.abort()
					throw new DOMException('Injected storage quota failure', 'QuotaExceededError')
				}
				if (kind === 'request') return this.add(...args)
				const request = originalPut.apply(this, args)
				request.addEventListener('success', () => this.transaction.abort(), { once: true })
				return request
			}
			return originalPut.apply(this, args)
		}
		let error, timer
		try {
			await Promise.race([
				fs.rename('.tmp.settings.json', 'settings.json'),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('rename did not settle')), 1500)
				}),
			])
		} catch (cause) {
			error = { name: cause.name, code: cause.code, message: cause.message }
		} finally {
			clearTimeout(timer)
			IDBObjectStore.prototype.put = originalPut
		}
		let currentContent, reopenedContent
		try {
			currentContent = await fs.readFile('settings.json', 'utf8')
		} catch (cause) {
			currentContent = { error: cause.code ?? cause.message }
		}
		try {
			reopened = await resolveMountConfig({ backend: IndexedDB, storeName: name })
			second = bindContext({ root: '/', pwd: '/', mounts: { '/': reopened } })
			reopenedContent = await second.fs.promises.readFile('settings.json', 'utf8')
		} catch (cause) {
			reopenedContent = { error: cause.code ?? cause.message }
		}
		Object.assign(result, { injected, error, currentContent, reopenedContent })
		return result
	} finally {
		IDBObjectStore.prototype.put = originalPut
		try {
			await release(reopened, second)
		} finally {
			try {
				await release(backing, ctx)
			} finally {
				result.leakedConnections = tracking.opened.size
				result.pendingTransactions = tracking.transactions.size
				await tracking.cleanup()
			}
		}
	}
}

function requestResult(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result)
		request.onerror = () => reject(request.error)
	})
}
function transactionDone(tx) {
	return new Promise((resolve, reject) => {
		tx.addEventListener('complete', resolve, { once: true })
		tx.addEventListener(
			'abort',
			() => reject(tx.error ?? new DOMException('aborted', 'AbortError')),
			{ once: true },
		)
	})
}
function trackedDatabases(names) {
	const opened = new Set(),
		transactions = new Set()
	const original = {
		open: IDBFactory.prototype.open,
		close: IDBDatabase.prototype.close,
		transaction: IDBDatabase.prototype.transaction,
	}
	IDBFactory.prototype.open = function (...args) {
		const request = original.open.apply(this, args)
		const retain = () => {
			if (names.has(request.result.name)) opened.add(request.result)
		}
		request.addEventListener('upgradeneeded', retain)
		request.addEventListener('success', retain)
		return request
	}
	IDBDatabase.prototype.close = function () {
		opened.delete(this)
		return original.close.call(this)
	}
	IDBDatabase.prototype.transaction = function (...args) {
		const tx = original.transaction.apply(this, args)
		if (names.has(this.name)) {
			transactions.add(tx)
			tx.addEventListener('complete', () => transactions.delete(tx), { once: true })
			tx.addEventListener('abort', () => transactions.delete(tx), { once: true })
		}
		return tx
	}
	return {
		opened,
		transactions,
		async cleanup() {
			for (const db of opened) db.close()
			IDBFactory.prototype.open = original.open
			IDBDatabase.prototype.close = original.close
			IDBDatabase.prototype.transaction = original.transaction
			for (const name of names)
				await new Promise((resolve, reject) => {
					const request = indexedDB.deleteDatabase(name)
					request.onsuccess = resolve
					request.onerror = () => reject(request.error)
					request.onblocked = () => reject(new Error(`Probe leaked a connection for ${name}`))
				})
		},
	}
}
async function rawRecords(name) {
	const db = await requestResult(indexedDB.open(name))
	try {
		const tx = db.transaction(name, 'readonly'),
			done = transactionDone(tx),
			store = tx.objectStore(name)
		const [keys, values] = await Promise.all([
			requestResult(store.getAllKeys()),
			requestResult(store.getAll()),
		])
		await done
		return keys.map((key, i) => [key, Array.from(new Uint8Array(values[i]))])
	} finally {
		db.close()
	}
}
async function seedProfile(name) {
	const backing = await resolveMountConfig({ backend: IndexedDB, storeName: name })
	const ctx = bindContext({ mounts: { '/': backing } })
	try {
		await ctx.fs.promises.writeFile('seed.txt', 'PRESERVE-ME')
	} finally {
		await release(backing, ctx)
	}
}
async function release(backing, ctx) {
	const errors = []
	if (ctx) {
		try {
			await ctx.dispose()
		} catch (error) {
			errors.push(error)
		}
		try {
			await vfs.umountAsync.call(ctx, '/')
		} catch (error) {
			errors.push(error)
		}
	}
	try {
		await backing?.close()
	} catch (error) {
		errors.push(error)
	}
	if (errors.length) throw new AggregateError(errors, 'Failed to release IndexedDB probe resources')
}

export async function runPreloadFailure() {
	const name = `pluxel-preload-${crypto.randomUUID()}`,
		tracking = trackedDatabases(new Set([name]))
	const originalGetAll = IDBObjectStore.prototype.getAll
	let injected = false
	try {
		await seedProfile(name)
		const before = await rawRecords(name)
		IDBObjectStore.prototype.getAll = function (...args) {
			if (!injected && this.transaction.db.name === name) {
				injected = true
				// A duplicate add produces a real asynchronous ConstraintError request.
				return this.add(new Uint8Array([99]), 0)
			}
			return originalGetAll.apply(this, args)
		}
		let failure, backing
		try {
			backing = await resolveMountConfig({ backend: IndexedDB, storeName: name })
		} catch (error) {
			failure = { name: error.name, code: error.code, message: error.message }
		} finally {
			IDBObjectStore.prototype.getAll = originalGetAll
		}
		const leakedConnections = tracking.opened.size
		const pendingTransactions = tracking.transactions.size
		const after = await rawRecords(name)
		await release(backing)
		return {
			kind: 'preload',
			injected,
			rejected: !!failure,
			failure,
			leakedConnections,
			pendingTransactions,
			unchanged: JSON.stringify(before) === JSON.stringify(after),
		}
	} finally {
		IDBObjectStore.prototype.getAll = originalGetAll
		await tracking.cleanup()
	}
}

export async function runCorruptRoot() {
	const name = `pluxel-corrupt-${crypto.randomUUID()}`,
		tracking = trackedDatabases(new Set([name]))
	let backing
	try {
		const request = indexedDB.open(name)
		request.onupgradeneeded = () => request.result.createObjectStore(name)
		const db = await requestResult(request)
		const tx = db.transaction(name, 'readwrite'),
			done = transactionDone(tx)
		tx.objectStore(name).put(new Uint8Array([13, 37]), 0)
		tx.objectStore(name).put(new TextEncoder().encode('ORIGINAL-BYTES'), 1)
		await done
		db.close()
		const before = await rawRecords(name)
		let failure
		try {
			backing = await resolveMountConfig({ backend: IndexedDB, storeName: name })
		} catch (error) {
			failure = { name: error.name, code: error.code, message: error.message }
		}
		const leakedConnections = tracking.opened.size,
			pendingTransactions = tracking.transactions.size
		const after = await rawRecords(name)
		return {
			kind: 'corrupt-root',
			rejected: !!failure,
			failure,
			leakedConnections,
			pendingTransactions,
			unchanged: JSON.stringify(before) === JSON.stringify(after),
		}
	} finally {
		await release(backing)
		await tracking.cleanup()
	}
}

export async function runMissingRoot() {
	const name = `pluxel-missing-root-${crypto.randomUUID()}`
	const tracking = trackedDatabases(new Set([name]))
	let backing
	try {
		await seedProfile(name)
		const db = await requestResult(indexedDB.open(name))
		try {
			const tx = db.transaction(name, 'readwrite')
			const done = transactionDone(tx)
			tx.objectStore(name).delete(0)
			await done
		} finally {
			db.close()
		}
		const before = await rawRecords(name)
		let failure
		try {
			backing = await resolveMountConfig({ backend: IndexedDB, storeName: name })
		} catch (error) {
			failure = { code: error.code, message: error.message }
		}
		const leakedConnections = tracking.opened.size
		const pendingTransactions = tracking.transactions.size
		const after = await rawRecords(name)
		return {
			kind: 'missing-root',
			rejected: !!failure,
			failure,
			leakedConnections,
			pendingTransactions,
			unchanged: JSON.stringify(before) === JSON.stringify(after),
		}
	} finally {
		try {
			await release(backing)
		} finally {
			await tracking.cleanup()
		}
	}
}

export async function runProfileLifecycle() {
	const firstName = `pluxel-profile-a-${crypto.randomUUID()}`,
		secondName = `pluxel-profile-b-${crypto.randomUUID()}`
	const tracking = trackedDatabases(new Set([firstName, secondName])),
		initialContexts = boundContexts.size,
		initialCaches = caches.size
	const resources = []
	async function create(name) {
		const backing = await resolveMountConfig({ backend: IndexedDB, storeName: name })
		const ctx = bindContext({ mounts: { '/': backing } })
		const resource = { backing, ctx, fs: ctx.fs.promises }
		resources.push(resource)
		return resource
	}
	try {
		const first = await create(firstName),
			second = await create(secondName)
		await Promise.all([
			first.fs.writeFile('profile.txt', 'PROFILE-A'),
			second.fs.writeFile('profile.txt', 'PROFILE-B'),
		])
		const separateBackings = first.backing !== second.backing
		const separateConnections = first.backing.store.db !== second.backing.store.db
		const firstValue = await first.fs.readFile('profile.txt', 'utf8'),
			secondValue = await second.fs.readFile('profile.txt', 'utf8')
		const sameProfile = await create(firstName)
		const sameProfileConnectionDistinct = sameProfile.backing.store.db !== first.backing.store.db
		await release(first.backing, first.ctx)
		const otherBorrowStillWorks = await sameProfile.fs.readFile('profile.txt', 'utf8')
		await release(sameProfile.backing, sameProfile.ctx)
		await release(second.backing, second.ctx)
		const cycles = []
		for (let cycle = 0; cycle < 12; cycle++) {
			const current = await create(firstName)
			await current.fs.writeFile('.tmp.cycle', String(cycle), { flag: 'wx', mode: 0o600 })
			await current.fs.rename('.tmp.cycle', 'cycle.txt')
			const value = await current.fs.readFile('cycle.txt', 'utf8')
			await release(current.backing, current.ctx)
			cycles.push({
				cycle,
				value,
				connections: tracking.opened.size,
				transactions: tracking.transactions.size,
				contexts: boundContexts.size - initialContexts,
				caches: caches.size - initialCaches,
			})
		}
		return {
			kind: 'profile-lifecycle',
			separateBackings,
			separateConnections,
			firstValue,
			secondValue,
			sameProfileConnectionDistinct,
			otherBorrowStillWorks,
			cycles,
		}
	} finally {
		for (const resource of resources) await release(resource.backing, resource.ctx)
		await tracking.cleanup()
	}
}

export async function runReadonly() {
	const name = `pluxel-readonly-${crypto.randomUUID()}`,
		missingName = `pluxel-readonly-missing-${crypto.randomUUID()}`
	const tracking = trackedDatabases(new Set([name, missingName]))
	let backing, ctx
	try {
		await seedProfile(name)
		const before = await rawRecords(name)
		backing = await resolveMountConfig({ backend: IndexedDB, storeName: name, readOnly: true })
		ctx = bindContext({ mounts: { '/': backing } })
		const fs = ctx.fs.promises,
			now = new Date()
		const mutations = {
			write: () => fs.writeFile('seed.txt', 'BAD'),
			empty: () => fs.writeFile('seed.txt', ''),
			truncate: () => fs.truncate('seed.txt', 0),
			chmod: () => fs.chmod('seed.txt', 0o777),
			utimes: () => fs.utimes('seed.txt', now, now),
			unlink: () => fs.unlink('seed.txt'),
			mkdir: () => fs.mkdir('new-dir'),
			rename: () => fs.rename('seed.txt', 'renamed.txt'),
		}
		const failures = {}
		for (const [operation, perform] of Object.entries(mutations)) {
			try {
				await perform()
				failures[operation] = 'resolved'
			} catch (error) {
				failures[operation] = error.code ?? error.name
			}
		}
		let missingRead
		try {
			await fs.readdir('missing-directory')
			missingRead = 'resolved'
		} catch (error) {
			missingRead = error.code ?? error.name
		}
		const listing = await fs.readdir('/')
		let preserved
		try {
			preserved = await fs.readFile('seed.txt', 'utf8')
		} catch (error) {
			preserved = { error: error.code ?? error.name }
		}
		await release(backing, ctx)
		const after = await rawRecords(name)
		let missingFailure, unexpected
		try {
			unexpected = await resolveMountConfig({
				backend: IndexedDB,
				storeName: missingName,
				readOnly: true,
			})
		} catch (error) {
			missingFailure = error.code ?? error.name
		}
		await release(unexpected)
		const createdMissing = (await indexedDB.databases()).some((db) => db.name === missingName)
		return {
			kind: 'readonly',
			failures,
			missingRead,
			listing,
			preserved,
			unchanged: JSON.stringify(before) === JSON.stringify(after),
			missingFailure,
			createdMissing,
			connections: tracking.opened.size,
			transactions: tracking.transactions.size,
		}
	} finally {
		await release(backing, ctx)
		await tracking.cleanup()
	}
}
