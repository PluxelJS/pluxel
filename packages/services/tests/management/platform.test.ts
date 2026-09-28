import { expect, it } from 'vitest'
import { describePluxelPlatform } from '../../src/management/platform-host'

it('returns a deeply frozen non-secret platform snapshot', () => {
	const snapshot = describePluxelPlatform()
	expect(snapshot.runtime.name).toEqual(expect.any(String))
	expect(snapshot.deployment.ci).toEqual(expect.any(Boolean))
	expect(Object.isFrozen(snapshot)).toBe(true)
	expect(Object.isFrozen(snapshot.runtime)).toBe(true)
	expect(Object.isFrozen(snapshot.deployment)).toBe(true)
})
