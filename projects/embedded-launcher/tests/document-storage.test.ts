import type { Json, NativeTransport } from '@embedded-launcher/sdk'
import { expect, it } from 'vitest'
import { createSession } from '../src/execution/session'
import { documentStorage } from '../src/execution/storage'

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

it('binds borrowed native document storage through the application factories', async () => {
	const documents = new Map<string, string>()
	let connectionClosed = false
	const transport = {
		async request(method: string, params: Json): Promise<Json> {
			const { key, document } = params as { key: string; document: string }
			if (method === 'storage.read') return { document: documents.get(key) ?? null }
			if (method === 'storage.write') {
				documents.set(key, document)
				return { committed: true }
			}
			return { accepted: true }
		},
		close() {
			connectionClosed = true
		},
	}
	const session = createSession(transport, {
		configStorage: documentStorage(transport, 'config'),
		stateStorage: documentStorage(transport, 'state'),
	})
	try {
		const response = JSON.parse(
			await session.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'host.status' })),
		)
		expect(response).toMatchObject({ result: { summary: { total: 0 } } })
	} finally {
		await session.close()
	}
	expect([...documents.keys()].sort()).toEqual(['config', 'state'])
	expect(connectionClosed).toBe(false)
})
