import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleBrowserNavigation } from '../src/app/router/navigationResult'

afterEach(() => vi.restoreAllMocks())

describe('browser navigation result boundary', () => {
	it('consumes reasonless cancellation rejections from superseded clicks', async () => {
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		settleBrowserNavigation(Promise.reject(undefined))
		await Promise.resolve()

		expect(report).not.toHaveBeenCalled()
	})

	it('reports real router failures after consuming their rejection', async () => {
		const failure = new Error('route load failed')
		const report = vi.spyOn(console, 'error').mockImplementation(() => undefined)

		settleBrowserNavigation(Promise.reject(failure))
		await Promise.resolve()

		expect(report).toHaveBeenCalledWith('[workbench-ui] browser navigation failed', failure)
	})
})
