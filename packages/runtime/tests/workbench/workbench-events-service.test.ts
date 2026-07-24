import { describe, expect, it, vi } from 'vitest'
import { WorkbenchEventsService } from '../../src/services/workbench/resources/WorkbenchEventsService'

function fixture() {
	const logger = {
		error: vi.fn(),
		warn: vi.fn(),
	}
	const service = new WorkbenchEventsService({ logger } as never, undefined)
	return { logger, service }
}

describe('WorkbenchEventsService failure containment', () => {
	it('reports detached subscription failures instead of leaking a rejected promise', async () => {
		const { logger, service } = fixture()
		const failure = new Error('attach failed')
		vi.spyOn(service as never, 'attachSubscriptionToSession').mockRejectedValue(failure)
		const session = {
			state: { requested: new Map([['stream', 'resource']]), handlers: new Map() },
			once: vi.fn(),
		}

		;(service as any).attachSession(session, {}, new URLSearchParams())
		await vi.waitFor(() => {
			expect(logger.error).toHaveBeenCalledWith('Workbench stream subscription attach failed', {
				error: failure,
				key: 'stream',
			})
		})
	})

	it('contains synchronous and asynchronous cleanup failures', async () => {
		const { logger, service } = fixture()
		const synchronous = new Error('sync cleanup failed')
		const asynchronous = new Error('async cleanup failed')

		expect(() =>
			(service as any).runCleanup(() => {
				throw synchronous
			}, 'sync'),
		).not.toThrow()
		;(service as any).runCleanup(() => Promise.reject(asynchronous), 'async')

		await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(2))
		expect(logger.warn).toHaveBeenCalledWith('cleanup failed for "{namespace}"', {
			namespace: 'sync',
			error: synchronous,
		})
		expect(logger.warn).toHaveBeenCalledWith('cleanup failed for "{namespace}"', {
			namespace: 'async',
			error: asynchronous,
		})
	})
})
