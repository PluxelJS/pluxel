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
