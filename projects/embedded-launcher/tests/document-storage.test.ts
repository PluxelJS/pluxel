import type { Json, NativeTransport } from '@embedded-launcher/sdk'
import { expect, it } from 'vitest'
import { createSession } from '../src/execution/session'
import { documentStorage } from '../src/execution/storage'
import { Calculator } from '../src/plugins/calculator'

it('waits for the native commit receipt before resolving a document write', async () => {
	const entered = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	let document = 'previous'
	const transport: NativeTransport = {
		async request(method, params) {
			if (method === 'storage.read') return { document }
			entered.resolve()
			await release.promise
			document = (params as { document: string }).document
			return { committed: true }
		},
	}
	const storage = documentStorage(transport, 'config')
	let committed = false
	const writing = storage.put('config.json', 'next').then((): undefined => {
		committed = true
		return undefined
	})
	try {
		await entered.promise
		expect(committed).toBe(false)
		expect(await storage.getText('config.json')).toBe('previous')
	} finally {
		release.resolve()
		await writing
	}
	expect(committed).toBe(true)
	expect(await storage.getText('config.json')).toBe('next')
})

it.each([null, {}, { committed: false }, { committed: 'true' }, []] as Json[])(
	'rejects a native write without a committed receipt: %j',
	async (receipt) => {
		const storage = documentStorage(
			{
				async request() {
					return receipt
				},
			},
			'state',
		)
		await expect(storage.put('state.json', '{}')).rejects.toThrow('Document not committed')
	},
)

it('rejects foreign document keys before calling native storage', async () => {
	let requests = 0
	const storage = documentStorage(
		{
			async request() {
				requests++
				return { committed: true }
			},
		},
		'config',
	)
	await expect(storage.getText('state.json')).rejects.toThrow('Invalid config document key')
	await expect(storage.stat('../config.json')).rejects.toThrow('Invalid config document key')
	await expect(storage.put('other.json', '{}')).rejects.toThrow('Invalid config document key')
	expect(requests).toBe(0)
})

it('writes borrowed native documents only for explicit management changes', async () => {
	const documents = new Map<string, string>()
	const writes: string[] = []
	let connectionClosed = false
	const transport = {
		async request(method: string, params: Json): Promise<Json> {
			const { key, document } = params as { key: string; document: string }
			if (method === 'storage.read') return { document: documents.get(key) ?? null }
			if (method === 'storage.write') {
				documents.set(key, document)
				writes.push(key)
				return { committed: true }
			}
			return { accepted: true }
		},
		close() {
			connectionClosed = true
		},
	}
	const session = createSession(
		transport,
		{
			configStorage: documentStorage(transport, 'config'),
			stateStorage: documentStorage(transport, 'state'),
		},
		[Calculator],
	)
	let id = 0
	const rpc = async (method: string, params = {}) =>
		JSON.parse(await session.dispatch(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })))
	try {
		expect(await rpc('host.status')).toMatchObject({ result: { summary: { total: 1 } } })
		expect(await rpc('host.startNode', { plugin: 'Calculator' })).toMatchObject({
			result: { status: { summary: { running: 1 } } },
		})
		expect(await rpc('host.configGet', { plugin: 'Calculator' })).toMatchObject({
			result: { ok: true, managedInput: null, effectiveInput: {}, config: { precision: 10 } },
		})
		expect(documents.size).toBe(0)
		expect(writes).toEqual([])
		expect(
			await rpc('host.config', { plugin: 'Calculator', patch: { set: { precision: 3 } } }),
		).toMatchObject({
			result: { ok: true, persistence: { status: 'confirmed' }, config: { precision: 3 } },
		})
		expect([...documents.keys()]).toEqual(['config'])
		expect(writes).toEqual(['config'])
		const configDocument = documents.get('config')
		expect(await rpc('host.autostart', { plugin: 'Calculator', autoStart: true })).toMatchObject({
			result: { report: { persistence: { status: 'confirmed' } } },
		})
		expect([...documents.keys()].sort()).toEqual(['config', 'state'])
		expect(documents.get('config')).toBe(configDocument)
	} finally {
		await session.close()
	}
	expect(writes).toEqual(['config', 'state'])
	expect(connectionClosed).toBe(false)
})
