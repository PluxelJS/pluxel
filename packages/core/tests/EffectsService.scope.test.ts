import { withCoreInternalTestContext } from '@pluxel/core/internal/test'
import { describe, expect, it } from 'vitest'

describe('EffectsService child scope ownership', () => {
	it('disposes child resources without over-cleaning the parent scope', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			const cleaned: string[] = []
			const parent = ctx.effects.defer(() => {
				cleaned.push('parent')
			})
			const child = ctx.effects.scope()
			child.defer(() => {
				cleaned.push('child')
			})

			await child.dispose()

			expect(cleaned).toEqual(['child'])
			expect(parent.active).toBe(true)

			await parent.dispose()
			expect(cleaned).toEqual(['child', 'parent'])
		})
	})

	it('propagates parent disposal into an owned child scope exactly once', async () => {
		await withCoreInternalTestContext(async (ctx) => {
			let childCleanups = 0
			const child = ctx.effects.scope()
			child.defer(() => {
				childCleanups++
			})

			await ctx.effects.dispose()
			await child.dispose()

			expect(childCleanups).toBe(1)
		})
	})
})
