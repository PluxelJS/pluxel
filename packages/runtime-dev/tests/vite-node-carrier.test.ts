import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ViteDevServer } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import {
	createSrvxViteNodeCarrierClose,
	dispatchSrvxViteNodeRequest,
} from '../src/vite-node-carrier'

function createServer() {
	const error = vi.fn()
	const ssrFixStacktrace = vi.fn()
	return {
		error,
		server: {
			config: { logger: { error } },
			ssrFixStacktrace,
		} as unknown as ViteDevServer,
		ssrFixStacktrace,
	}
}

function createRequest(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
	return {
		aborted: false,
		destroyed: false,
		...overrides,
	} as IncomingMessage
}

function createResponse(overrides: Partial<ServerResponse> = {}) {
	const end = vi.fn()
	const destroy = vi.fn()
	return {
		destroy,
		destroyed: false,
		end,
		headersSent: false,
		statusCode: 200,
		statusMessage: 'OK',
		writableEnded: false,
		...overrides,
	} as unknown as ServerResponse
}

describe('Vite Node carrier boundaries', () => {
	it('normalizes and handles a rejected handler without a reason', async () => {
		const { error, server, ssrFixStacktrace } = createServer()
		const response = createResponse()

		dispatchSrvxViteNodeRequest(server, () => Promise.reject(undefined), createRequest(), response)
		await vi.waitFor(() => expect(error).toHaveBeenCalledOnce())

		const reported = error.mock.calls[0]![1].error as Error
		expect(reported).toBeInstanceOf(Error)
		expect(reported.message).toContain('without a rejection reason')
		expect(ssrFixStacktrace).toHaveBeenCalledWith(reported)
		expect(response.statusCode).toBe(500)
		expect(response.statusMessage).toBe('')
		expect(response.end).toHaveBeenCalledOnce()
	})

	it('treats client disconnect rejection as an expected request termination', async () => {
		const { error, server, ssrFixStacktrace } = createServer()
		const response = createResponse({ destroyed: true })

		dispatchSrvxViteNodeRequest(
			server,
			() => Promise.reject(undefined),
			createRequest({ aborted: true }),
			response,
		)
		await Promise.resolve()
		await Promise.resolve()

		expect(error).not.toHaveBeenCalled()
		expect(ssrFixStacktrace).not.toHaveBeenCalled()
		expect(response.end).not.toHaveBeenCalled()
	})

	it('shares one normalized close result across concurrent callers', async () => {
		const detach = vi.fn()
		const closeCarrier = vi.fn(() => Promise.reject(undefined))
		const close = createSrvxViteNodeCarrierClose(detach, closeCarrier)

		const first = close()
		const second = close()
		expect(second).toBe(first)
		await expect(first).rejects.toThrow('srvx carrier close failed without a rejection reason')
		await expect(second).rejects.toThrow('srvx carrier close failed without a rejection reason')
		expect(detach).toHaveBeenCalledOnce()
		expect(closeCarrier).toHaveBeenCalledOnce()
	})
})
