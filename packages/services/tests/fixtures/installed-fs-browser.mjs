import { createHost } from '@pluxel/host/browser'
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { Fs, PluginFs, fs, InMemory, writeFileAtomic } from '@pluxel/services/fs'

const views = new Map()
class Owner extends BasePlugin {
	async init() {
		views.set(
			this.ctx.pluginInfo.nodeAddress.definition.exportName,
			await this.ctx.require(PluginFs)(),
		)
	}
}
class First extends Owner {}
class Second extends Owner {}
const address = (type) => ({
	definition: {
		entry: { kind: 'package-root', packageName: 'installed-fs-browser' },
		exportName: type.name,
	},
	variant: 'default',
})
for (const type of [First, Second]) {
	Plugin()(type)
	__setPluginDefinition(type, {
		abiVersion: PLUGIN_LOWERING_ABI_VERSION,
		kind: 'plugin',
		definition: address(type).definition,
	})
}

async function startOwners(host) {
	for (const type of [First, Second]) await host.startNode(address(type))
	return [views.get('First'), views.get('Second')]
}

async function deleteDatabase(storeName) {
	await new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(storeName)
		request.onsuccess = resolve
		request.onerror = () => reject(request.error)
		request.onblocked = () => reject(new Error('Filesystem still owns an IndexedDB connection'))
	})
}

export async function memory() {
	const host = await createHost({ plugins: [], services: [fs({ backend: InMemory })] })
	try {
		const io = await host.ctx.require(Fs).directory('documents')
		await io.writeFile('value', 'MEMORY')
		return await io.readFile('value', 'utf8')
	} finally {
		await host.close()
	}
}

export async function persisted() {
	const { IndexedDB } = await import('@pluxel/services/fs/browser')
	const storeName = `installed-fs-${crypto.randomUUID()}`
	let host
	try {
		const rounds = []
		let missingOtherOwner
		for (let round = 0; round < 3; round++) {
			host = await createHost({
				plugins: [First, Second],
				services: [fs({ backend: IndexedDB, storeName })],
			})
			const [first, second] = await startOwners(host)
			if (round === 0) {
				await writeFileAtomic(first, 'value', 'PERSISTED')
				try {
					await second.readFile('value')
				} catch (error) {
					missingOtherOwner = error.code
				}
				await writeFileAtomic(second, 'value', 'OWNER-B')
				await first.writeFile('empty', 'OLD')
				await first.writeFile('empty', '')
				await first.writeFile('binary', Uint8Array.of(0, 1, 255))
			}
			const result = {
				content: await first.readFile('value', 'utf8'),
				otherOwner: await second.readFile('value', 'utf8'),
			}
			await host.close()
			host = undefined
			try {
				await first.readFile('value')
			} catch (error) {
				result.closed = error.code
			}
			rounds.push(result)
			views.clear()
		}
		host = await createHost({
			plugins: [First, Second],
			services: [fs({ backend: IndexedDB, storeName, readOnly: true })],
		})
		const [reopened] = await startOwners(host)
		let readonly
		try {
			await reopened.writeFile('value', 'CHANGED')
		} catch (error) {
			readonly = error.code
		}
		return {
			content: await reopened.readFile('value', 'utf8'),
			empty: await reopened.readFile('empty', 'utf8'),
			binary: Array.from(await reopened.readFile('binary')),
			readonly,
			missingOtherOwner,
			rounds,
		}
	} finally {
		await host?.close()
		views.clear()
		await deleteDatabase(storeName)
	}
}

export async function corruptConfig() {
	const { IndexedDB } = await import('@pluxel/services/fs/browser')
	const storeName = `installed-fs-bootstrap-${crypto.randomUUID()}`
	let host
	try {
		host = await createHost({ plugins: [], services: [fs({ backend: IndexedDB, storeName })] })
		const directory = await host.ctx.require(Fs).directory('host/config')
		await directory.writeFile('config.json', Uint8Array.of(123, 10, 0, 255))
		await host.close()
		host = undefined
		let failure
		let documents
		try {
			host = await createHost({
				plugins: [],
				services: [fs({ backend: IndexedDB, storeName })],
				configRecords: {
					storage: (root) => (documents = root.require(Fs).documents('host/config')),
				},
			})
		} catch (error) {
			failure = error
		}
		let closed
		try {
			await documents.getText('config.json')
		} catch (error) {
			closed = error.code
		}
		await host?.close()
		host = await createHost({ plugins: [], services: [fs({ backend: IndexedDB, storeName })] })
		const reopened = await host.ctx.require(Fs).directory('host/config')
		return {
			failure: failure?.message,
			cause: failure?.cause?.name,
			closed,
			bytes: Array.from(await reopened.readFile('config.json')),
		}
	} finally {
		await host?.close()
		await deleteDatabase(storeName)
	}
}
