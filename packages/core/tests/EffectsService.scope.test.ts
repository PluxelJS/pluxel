import { withCoreInternalTestContext } from '@pluxel/core/internal/test'
import { expect, it } from 'vitest'

it('allows child disposal before the root drains other scopes and skips already released entries', async () => {
	await withCoreInternalTestContext(async ({ effects }) => {
		const cleaned: string[] = []
		effects.defer(() => {
			cleaned.push('root')
		})
		const first = effects.scope()
		first.defer(() => {
			cleaned.push('first')
		})
		const second = effects.scope()
		second.defer(() => {
			cleaned.push('second')
		})

		await first.dispose()
		expect(cleaned).toEqual(['first'])
		await effects.dispose()
		await second.dispose()
		expect(cleaned).toEqual(['first', 'second', 'root'])
	})
})

it('bounds parent registrations and phase handles across completed child scopes and cancelled guards', async () => {
	await withCoreInternalTestContext(async ({ effects }) => {
		const { impl } = effects as unknown as {
			impl: { aById: unknown[]; stacks: number[][] }
		}
		const countRegistrations = () => impl.aById.filter((entry) => entry != null).length
		const cleanups: string[] = []
		effects.defer(() => {
			cleanups.push('runtime first')
		})
		effects.defer(
			() => {
				cleanups.push('shutdown')
			},
			{ phase: 'shutdown' },
		)
		const initialRegistrations = countRegistrations()
		let released = 0
		for (let i = 0; i < 512; i++) {
			const child = effects.scope()
			child.defer(() => {
				released++
			})
			await child.dispose()
			const guard = effects.defer(() => {
				throw new Error('cancelled cleanup ran')
			})
			guard.cancel()
			const reused = effects.defer(() => {})
			guard.cancel()
			expect(reused.active).toBe(true)
			reused.cancel()
		}
		expect(released).toBe(512)
		expect(countRegistrations()).toBe(initialRegistrations)
		expect(impl.stacks.flat().length).toBeLessThan(128)

		effects.defer(() => {
			cleanups.push('runtime last')
			effects.defer(
				() => {
					cleanups.push('registered during drain')
				},
				{ phase: 'shutdown' },
			)
		})
		await effects.dispose()
		expect(cleanups).toEqual([
			'shutdown',
			'runtime last',
			'registered during drain',
			'runtime first',
		])
	})
})

it('keeps a child owned while its independent cleanup is running', async () => {
	await withCoreInternalTestContext(async ({ effects }) => {
		const cleanup = Promise.withResolvers<void>()
		const order: string[] = []
		effects.defer(() => {
			order.push('parent')
		})
		const child = effects.scope()
		child.defer(async () => {
			order.push('child started')
			await cleanup.promise
			order.push('child finished')
		})
		const childClosing = child.dispose()
		const parentClosing = effects.dispose()
		try {
			await Promise.resolve()
			expect(child.dispose()).toBe(childClosing)
			expect(order).toEqual(['child started'])
		} finally {
			cleanup.resolve()
		}
		await Promise.all([childClosing, parentClosing])
		expect(order).toEqual(['child started', 'child finished', 'parent'])
	})
})

it('publishes the child drain before cleanup can ask its parent to close', async () => {
	await withCoreInternalTestContext(async ({ effects }) => {
		const order: string[] = []
		let parentClosing: Promise<void> | undefined
		effects.defer(() => {
			order.push('parent finished')
		})
		const child = effects.scope()
		child.defer(() => {
			order.push('child finished')
		})
		child.defer(() => {
			parentClosing = effects.dispose()
			order.push('parent close requested')
		})
		await child.dispose()
		await parentClosing
		expect(order).toEqual(['parent close requested', 'child finished', 'parent finished'])
	})
})

it('bounds dead handles in the root and nested transaction stacks before rollback', async () => {
	await withCoreInternalTestContext(async ({ effects }) => {
		const order: string[] = []
		const failure = new Error('rollback')
		const stackSize = (transaction: unknown) =>
			(transaction as { tx: { handles: number[][] } }).tx.handles.flat().length
		await expect(
			effects.transaction(async (outer) => {
				outer.defer(() => {
					order.push('outer first')
				})
				await outer.transaction(async (inner) => {
					inner.defer(() => {
						order.push('inner')
					})
					for (let i = 0; i < 512; i++) inner.defer(() => {}).cancel()
					expect(stackSize(inner)).toBeLessThan(128)
					expect(stackSize(outer)).toBeLessThan(128)
				})
				outer.defer(() => {
					order.push('outer last')
				})
				throw failure
			}),
		).rejects.toBe(failure)
		expect(order).toEqual(['outer last', 'inner', 'outer first'])
	})
})
