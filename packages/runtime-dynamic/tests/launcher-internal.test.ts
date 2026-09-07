import { beforeEach, describe, expect, it, vi } from 'vitest'

const vite = vi.hoisted(() => ({
	createServer: vi.fn(),
	dynamicRuntimeVitePlugin: vi.fn(() => ['dynamic-plugin']),
}))

vi.mock('vite', () => ({ createServer: vite.createServer }))
vi.mock('../src/vite.ts', () => ({ dynamicRuntimeVitePlugin: vite.dynamicRuntimeVitePlugin }))

import { startOwnedDynamicRuntimeViteServer } from '../src/launcher-internal.ts'

describe('owned dynamic Runtime Vite server', () => {
	beforeEach(() => {
		vite.createServer.mockReset()
		vite.dynamicRuntimeVitePlugin.mockClear()
	})

	it('uses the canonical route plugin and reports the bound loopback origin', async () => {
		const server = createServerDouble({ port: 43123 })
		vite.createServer.mockResolvedValue(server)

		const result = await startOwnedDynamicRuntimeViteServer({
			entry: '/workspace/src/pluxel.dynamic.ts',
			root: '/workspace',
		})

		expect(vite.dynamicRuntimeVitePlugin).toHaveBeenCalledWith({
			entry: '/workspace/src/pluxel.dynamic.ts',
		})
		expect(vite.createServer).toHaveBeenCalledWith({
			configFile: false,
			root: '/workspace',
			plugins: ['dynamic-plugin'],
			server: { host: '127.0.0.1', port: 0, strictPort: true },
		})
		expect(result).toEqual({ server, origin: 'http://127.0.0.1:43123' })
	})

	it('closes acquired Runtime and Vite resources before rejecting an abort', async () => {
		let resolveListen!: () => void
		const listen = new Promise<void>((resolve) => {
			resolveListen = resolve
		})
		const server = createServerDouble({ port: 43123, listen })
		vite.createServer.mockResolvedValue(server)
		const controller = new AbortController()

		const starting = startOwnedDynamicRuntimeViteServer({
			entry: '/workspace/src/pluxel.dynamic.ts',
			root: '/workspace',
			signal: controller.signal,
		})
		await vi.waitFor(() => expect(server.listen).toHaveBeenCalledOnce())
		controller.abort(new Error('cancel startup'))
		resolveListen()

		await expect(starting).rejects.toThrow('cancel startup')
		expect(server.close).toHaveBeenCalledOnce()
	})

	it('preserves startup and cleanup failures', async () => {
		const startupError = new Error('listen failed')
		const cleanupError = new Error('close failed')
		const server = createServerDouble({
			port: 43123,
			listen: Promise.reject(startupError),
			close: Promise.reject(cleanupError),
		})
		vite.createServer.mockResolvedValue(server)

		const error = await startOwnedDynamicRuntimeViteServer({
			entry: '/workspace/src/pluxel.dynamic.ts',
			root: '/workspace',
		}).catch((cause: unknown) => cause)

		expect(error).toBeInstanceOf(AggregateError)
		expect((error as AggregateError).errors).toEqual([startupError, cleanupError])
	})
})

function createServerDouble(options: {
	port: number
	listen?: Promise<void>
	close?: Promise<void>
}) {
	return {
		httpServer: { address: () => ({ address: '127.0.0.1', family: 'IPv4', port: options.port }) },
		listen: vi.fn(() => options.listen ?? Promise.resolve()),
		close: vi.fn(() => options.close ?? Promise.resolve()),
	}
}
