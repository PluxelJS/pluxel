import { BasePlugin, Plugin } from '@pluxel/core'
import { requireTinyBaseHost } from '@pluxel/core/internal'
import { writeFileAtomic } from '@pluxel/core/fs'
import { IndexedDB } from '@pluxel/core/fs/browser'
import { createHost, type HostOptions, type PluginHost } from '@pluxel/host/embedded'
import * as v from 'valibot'

let running: Awaited<ReturnType<Owner['openStorage']>>

@Plugin()
class Owner extends BasePlugin {
	readonly config = this.configs.use(
		v.object({ label: v.optional(v.pipe(v.string(), v.trim()), 'initial') }),
	)
	protected override async init() {
		running = await this.openStorage()
	}
	async openStorage() {
		const store = await this.ctx.tinybase.open()
		const files = await this.ctx.fs()
		return { owner: this, store, files }
	}
}

export async function run() {
	const storeName = 'pluxel-built-in-' + crypto.randomUUID()
	const owner = Owner.nodeAddress()
	const options = {
		plugins: [{ plugin: Owner }],
		coreConfig: {
			zenfs: { mounts: { '/': { backend: IndexedDB, storeName } }, durableMounts: ['/'] },
		},
		policy: { document: false },
	} satisfies HostOptions
	let host: PluginHost | undefined
	try {
		host = await createHost(options)
		const patched = await host.config.patch(owner, { set: { label: ' persisted ' } })
		if (patched.ok === false) throw new Error(patched.message)
		await host.startNode(owner)
		running.store.setValue('value', 42)
		await running.owner.ctx.tinybase.flush()
		await writeFileAtomic(running.files, 'owner.txt', 'OWNER-FILE')
		const { store: staleStore, files: staleFiles } = running
		await host.close()
		let closed: unknown
		try {
			await staleFiles.readFile('owner.txt')
		} catch (error) {
			if (!error || typeof error !== 'object' || !('code' in error)) throw error
			closed = error.code
		}
		staleStore.setValue('stale', true)
		host = await createHost(options)
		const config = await host.config.get(owner)
		if (config.ok === false) throw new Error(config.message)
		const beforeStart = {
			stores: requireTinyBaseHost(host.ctx)
				.status()
				.filter((item) => item.identity.kind === 'plugin').length,
			label: config.config.label,
			application: config.application,
		}
		await host.startNode(owner)
		const storedValue: unknown = running.store.getValue('value')
		const reopened = {
			label: running.owner.config.label,
			value: storedValue,
			file: await running.files.readFile('owner.txt', 'utf8'),
		}
		return {
			beforeStart,
			reopened,
			closed,
			stalePersisted: running.store.hasValue('stale'),
			execution: typeof document === 'undefined' ? 'worker' : 'window',
			nodeGlobals:
				typeof process !== 'undefined' ||
				typeof Buffer !== 'undefined' ||
				typeof require !== 'undefined',
		}
	} finally {
		await host?.close()
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.deleteDatabase(storeName)
			request.onsuccess = () => resolve()
			request.onerror = () => reject(request.error)
			request.onblocked = () => reject(new Error('Host leaked an IDB connection'))
		})
	}
}
