import { describe, expect, it, vi } from 'vitest'
import { createSseResponse, type SseStreamWriter } from '../../src/services/http/sse'

describe('SSE response lifecycle', () => {
	it('terminates the writer when the response consumer cancels', async () => {
		let writer: SseStreamWriter | undefined
		let releaseHandler: (() => void) | undefined
		const aborted = vi.fn()
		const response = createSseResponse(new Request('http://runtime.test/events'), async (value) => {
			writer = value
			value.onAbort(aborted)
			await new Promise<void>((resolve) => {
				releaseHandler = resolve
			})
		})

		await vi.waitFor(() => expect(writer).toBeDefined())
		const reader = response.body!.getReader()
		await reader.cancel()

		expect(aborted).toHaveBeenCalledOnce()
		await expect(writer!.write('after cancel')).resolves.toBeUndefined()
		await expect(writer!.writeSSE({ event: 'late', data: 'value' })).resolves.toBeUndefined()
		releaseHandler!()
	})

	it('runs every abort handler even when another cleanup throws', async () => {
		let writer: SseStreamWriter | undefined
		let releaseHandler: (() => void) | undefined
		const afterFailure = vi.fn()
		const response = createSseResponse(new Request('http://runtime.test/events'), async (value) => {
			writer = value
			value.onAbort(() => {
				throw new Error('cleanup failed')
			})
			value.onAbort(afterFailure)
			await new Promise<void>((resolve) => {
				releaseHandler = resolve
			})
		})

		await vi.waitFor(() => expect(writer).toBeDefined())
		await expect(response.body!.cancel()).resolves.toBeUndefined()
		expect(afterFailure).toHaveBeenCalledOnce()
		releaseHandler!()
	})

	it('normalizes a handler rejection without a reason at the stream boundary', async () => {
		const response = createSseResponse(new Request('http://runtime.test/events'), () =>
			Promise.reject(undefined),
		)
		const reader = response.body!.getReader()

		await expect(reader.read()).rejects.toThrow(
			'[runtime:sse] stream handler failed without a rejection reason',
		)
	})
})
