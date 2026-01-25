import { afterEach, describe, expect, it, spyOn } from 'bun:test'

import { withTestContext } from '@pluxel/core/test'

describe('EffectScopeService', () => {
	const restores: Array<() => void> = []
	const remember = (fn: () => void) => {
		restores.push(fn)
	}

	afterEach(() => {
		while (restores.length) {
			const restore = restores.pop()
			try {
				restore?.()
			} catch {}
		}
	})

	it('collectEffect disposes registered callbacks exactly once', () => {
		return withTestContext((ctx) => {
			let primary = 0
			let secondary = 0

			const cancelPrimary = ctx.scope.collectEffect(() => {
				primary += 1
			})
			ctx.scope.collectEffect(() => {
				secondary += 1
			})

			expect(ctx.scope.disposables.size).toBe(2)

			cancelPrimary()
			expect(ctx.scope.disposables.size).toBe(1)

			ctx.scope.disposeAll()

			expect(primary).toBe(0)
			expect(secondary).toBe(1)
			expect(ctx.scope.disposables.size).toBe(0)

			ctx.scope.disposeAll()
			expect(secondary).toBe(1)
		})
	})

	it('logs and continues when disposer throws', () => {
		return withTestContext((ctx) => {
			const errorSpy = spyOn(ctx.logger as any, 'error').mockImplementation(
				(..._args: any[]) => {},
			)
			remember(() => errorSpy.mockRestore())

			const err = new Error('dispose boom')
			ctx.scope.collectEffect(() => {
				throw err
			})

			ctx.scope.disposeAll()

			expect(errorSpy).toHaveBeenCalledTimes(1)
			expect((errorSpy as any).mock.calls[0]).toEqual(['dispose error', { error: err }])
			expect(ctx.scope.disposables.size).toBe(0)
		})
	})
})
