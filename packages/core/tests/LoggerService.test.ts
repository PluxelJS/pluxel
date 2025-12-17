import { afterEach, describe, expect, it, spyOn } from 'bun:test'

import { withTestContext } from '@pluxel/core/test'

describe('LoggerService', () => {
	const originalTrace = console.trace
	const cleanup: Array<() => void> = []
	const remember = (fn: () => void) => cleanup.push(fn)
	const restoreAll = () => {
		while (cleanup.length) {
			const restore = cleanup.pop()
			try {
				restore?.()
			} catch {}
		}
	}
	afterEach(() => {
		restoreAll()
		console.trace = originalTrace
	})

	it('prefixes messages with root context name when plugin info is missing', () => {
		return withTestContext(
			(ctx) => {
				const infoSpy = spyOn(console, 'info')
				remember(() => infoSpy.mockRestore())

				ctx.logger.info('hello', { id: 1 })

				expect(infoSpy).toHaveBeenCalledTimes(1)
				expect(infoSpy.mock.calls[0]).toEqual(['[root:core-test]', 'hello', { id: 1 }])
			},
			{ name: 'core-test' },
		)
	})

	it('uses plugin id when available', () => {
		return withTestContext(
			(ctx) => {
				ctx.pluginInfo = { id: 'PluginX' } as any
				const warnSpy = spyOn(console, 'warn')
				remember(() => warnSpy.mockRestore())

				ctx.logger.warn('warn message')

				expect(warnSpy).toHaveBeenCalledTimes(1)
				expect(warnSpy.mock.calls[0]).toEqual(['[PluginX:plugin-test]', 'warn message'])
			},
			{ name: 'plugin-test' },
		)
	})

	it('falls back to console.log when level method is missing', () => {
		return withTestContext(
			(ctx) => {
				const logSpy = spyOn(console, 'log')
				remember(() => logSpy.mockRestore())

				remember(() => {
					console.trace = originalTrace
				})
				console.trace = undefined as any
				ctx.logger.trace('trace missing')

				expect(logSpy).toHaveBeenCalledTimes(1)
				expect(logSpy.mock.calls[0]).toEqual(['[root:trace-fallback]', 'trace missing'])
			},
			{ name: 'trace-fallback' },
		)
	})
})
