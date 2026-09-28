import { describe, expect, it } from 'vitest'
import { withCoreInternalTestContext } from '@pluxel/core/internal/test'
import type { Effects } from '@pluxel/core'
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

	it('transaction rollback disposes its own registrations', async () => {
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

	it('acquire rejects before starting work on a disposed scope', async () => {
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
			expect(released).toBe(0)
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
	it('rejects sibling transactions and preserves resources registered before rollback', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const cleaned: string[] = []
			ctx.effects.defer(() => {
				cleaned.push('before')
			})
			const gate = Promise.withResolvers<void>()
			const pending = ctx.effects.transaction(async (tx) => {
				tx.defer(() => {
					cleaned.push('transaction')
				})
				await gate.promise
				throw new Error('rollback')
			})
			await expect(ctx.effects.transaction(() => {})).rejects.toThrow(EffectsFrozenError)
			gate.resolve()
			await expect(pending).rejects.toThrow('rollback')
			expect(cleaned).toEqual(['transaction'])
			await ctx.effects.dispose()
			expect(cleaned).toEqual(['transaction', 'before'])
		})
	})

	it('owns nested commits and only rolls back failed child registrations', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const cleaned: string[] = []
			await expect(
				ctx.effects.transaction(async (tx) => {
					tx.defer(() => {
						cleaned.push('outer')
					})
					await expect(
						tx.transaction((child) => {
							child.defer(() => {
								cleaned.push('failed child')
							})
							throw new Error('child')
						}),
					).rejects.toThrow('child')
					expect(cleaned).toEqual(['failed child'])
					await tx.transaction((child) => {
						child.defer(() => {
							cleaned.push('committed child')
						})
					})
					throw new Error('outer')
				}),
			).rejects.toThrow('outer')
			expect(cleaned).toEqual(['failed child', 'committed child', 'outer'])
		})
	})

	it('revokes committed and rolled-back views, including acquire before it starts', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			for (const fail of [false, true]) {
				let view!: Effects
				await ctx.effects
					.transaction((tx) => {
						view = tx
						if (fail) throw new Error('rollback')
					})
					.catch(() => {})
				expect(() => view.defer(() => {})).toThrow(EffectsDisposedError)
				expect(() => view.scope()).toThrow(EffectsDisposedError)
				await expect(view.transaction(() => {})).rejects.toThrow(EffectsDisposedError)
				let started = false
				await expect(
					view.acquire(
						() => {
							started = true
						},
						() => {},
					),
				).rejects.toThrow(EffectsDisposedError)
				expect(started).toBe(false)
			}
		})
	})

	it('releases acquisitions that settle after their transaction callback', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const resource = Promise.withResolvers<string>()
			const released: string[] = []
			let acquisition!: Promise<string>
			await ctx.effects.transaction((tx) => {
				acquisition = tx.acquire(
					() => resource.promise,
					(value) => {
						released.push(value)
					},
				)
			})
			const rejected = acquisition.catch((error: unknown) => error)
			resource.resolve('late')
			expect(await rejected).toBeInstanceOf(EffectsDisposedError)
			expect(released).toEqual(['late'])
		})
	})

	it('tx.dispose releases only its own resources and keeps outer scope usable', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			let parentReleased = false
			const parent = ctx.effects.defer(() => {
				parentReleased = true
			})
			await expect(
				ctx.effects.transaction(async (tx) => {
					tx.defer(() => {})
					await tx.dispose()
				}),
			).rejects.toThrow(EffectsDisposedError)
			expect(parent.active).toBe(true)
			expect(parentReleased).toBe(false)
			ctx.effects.defer(() => {})
		})
	})

	it('parent disposal revokes a pending transaction and late acquire releases exactly once', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const resource = Promise.withResolvers<string>()
			let released = 0
			const transaction = ctx.effects.transaction(async (tx) => {
				await tx.acquire(
					() => resource.promise,
					() => {
						released++
					},
				)
			})
			const rejected = transaction.catch((error: unknown) => error)
			await ctx.effects.dispose()
			resource.resolve('late')
			expect(await rejected).toBeInstanceOf(EffectsDisposedError)
			expect(released).toBe(1)
		})
	})

	it('keeps sibling admission frozen until rollback cleanup settles', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const cleanup = Promise.withResolvers<void>()
			const entered = Promise.withResolvers<void>()
			const failed = ctx.effects.transaction((tx) => {
				tx.defer(async () => {
					entered.resolve()
					await cleanup.promise
				})
				throw new Error('rollback')
			})
			const rejected = failed.catch((error: unknown) => error)
			await entered.promise
			await expect(ctx.effects.transaction(() => {})).rejects.toThrow(EffectsFrozenError)
			let disposed = false
			const disposal = ctx.effects.dispose().then((): void => {
				disposed = true
				return undefined
			})
			await Promise.resolve()
			expect(disposed).toBe(false)
			cleanup.resolve()
			expect(await rejected).toMatchObject({ message: 'rollback' })
			await disposal
		})
	})

	it('withdraws unawaited children without letting their later callback unlock a new transaction', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const childGate = Promise.withResolvers<void>()
			let child!: Promise<void>
			let released = 0
			await expect(
				ctx.effects.transaction((tx) => {
					child = tx.transaction(async (nested) => {
						nested.defer(() => {
							released++
						})
						await childGate.promise
					})
				}),
			).rejects.toThrow(EffectsFrozenError)
			expect(released).toBe(1)
			await ctx.effects.transaction(async (tx) => {
				const rejected = child.catch((error: unknown) => error)
				childGate.resolve()
				expect(await rejected).toBeInstanceOf(EffectsDisposedError)
				expect(() => ctx.effects.defer(() => {})).toThrow(EffectsFrozenError)
				tx.defer(() => {})
			})
		})
	})
	it('retains parent admission lock when a nested rollback finishes first', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const childCleanup = Promise.withResolvers<void>()
			const parentCleanup = Promise.withResolvers<void>()
			const parentEntered = Promise.withResolvers<void>()
			let child!: Promise<void>
			const parent = ctx.effects.transaction((tx) => {
				tx.defer(async () => {
					parentEntered.resolve()
					await parentCleanup.promise
				})
				child = tx.transaction((nested) => {
					nested.defer(() => childCleanup.promise)
					throw new Error('child')
				})
				throw new Error('parent')
			})
			const parentRejected = parent.catch((error: unknown) => error)
			const childRejected = child.catch((error: unknown) => error)
			childCleanup.resolve()
			expect(await childRejected).toMatchObject({ message: 'child' })
			await parentEntered.promise
			await expect(ctx.effects.transaction(() => {})).rejects.toThrow(EffectsFrozenError)
			parentCleanup.resolve()
			expect(await parentRejected).toMatchObject({ message: 'parent' })
			await ctx.effects.transaction(() => {})
		})
	})
})
