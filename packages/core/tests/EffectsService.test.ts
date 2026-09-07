import { describe, expect, it } from 'vitest'
import { withCoreInternalTestContext } from '@pluxel/core/internal/test'
import { EffectsDisposedError, EffectsFrozenError } from '../src/services/effects/EffectsService'

describe('EffectsService', () => {
	it('awaits an owned task whose disposal cancels and drains its work', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const controller = new AbortController()
			let drained = false
			const task = new Promise<void>((resolve) => {
				controller.signal.addEventListener(
					'abort',
					() => {
						queueMicrotask(() => {
							drained = true
							resolve()
						})
					},
					{ once: true },
				)
			})

			ctx.effects.own({
				async dispose() {
					controller.abort()
					await task
				},
			})

			await ctx.effects.dispose()
			expect(controller.signal.aborted).toBe(true)
			expect(drained).toBe(true)
		})
	})

	it('defer: cancel prevents disposal; dispose is idempotent', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			let ran = 0

			const g1 = ctx.effects.defer(() => {
				ran += 1
			})
			ctx.effects.defer(() => {
				ran += 1
			})

			g1.cancel()

			await ctx.effects.dispose()
			expect(ran).toBe(1)

			await ctx.effects.dispose()
			expect(ran).toBe(1)
		})
	})

	it('dispose drains re-entrant registrations in the same call', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			let ran = 0
			ctx.effects.defer(() => {
				ctx.effects.defer(() => {
					ran += 1
				})
			})

			await ctx.effects.dispose()
			expect(ran).toBe(1)
		})
	})

	it('transaction freezes outer effects API but allows tx view', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			let ran = 0
			await ctx.effects.transaction(async (tx) => {
				expect(() => ctx.effects.defer(() => {})).toThrow(EffectsFrozenError)
				tx.defer(() => {
					ran += 1
				})
			})

			await ctx.effects.dispose()
			expect(ran).toBe(1)
		})
	})

	it('transaction rollback disposes checkpoint range', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			let ran = 0
			await expect(
				ctx.effects.transaction(async (tx) => {
					tx.defer(() => {
						ran += 1
					})
					throw new Error('boom')
				}),
			).rejects.toThrow('boom')

			expect(ran).toBe(1)
			await ctx.effects.dispose()
			expect(ran).toBe(1)
		})
	})

	it('acquire releases immediately when registration fails (disposed)', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			let released = 0
			await ctx.effects.dispose()
			await expect(
				ctx.effects.acquire(
					async () => ({ ok: true }),
					async () => {
						released += 1
					},
				),
			).rejects.toThrow(EffectsDisposedError)
			expect(released).toBe(1)
		})
	})

	it('dispose aggregates errors (continue-on-error)', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			ctx.effects.defer(() => {
				throw new Error('a')
			})
			ctx.effects.defer(() => {
				throw new Error('b')
			})

			await expect(ctx.effects.dispose()).rejects.toBeInstanceOf(AggregateError)
		})
	})

	it('transaction preserves original error, but surfaces rollback errors too', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			await expect(
				ctx.effects.transaction(async (tx) => {
					tx.defer(() => {
						throw new Error('rollback-boom')
					})
					throw new Error('fn-boom')
				}),
			).rejects.toBeInstanceOf(AggregateError)
		})
	})
})
