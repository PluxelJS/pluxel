import { expect } from 'vitest'

export function expectPublicSurface(publicMod: object, internalMod: object) {
	const publicKeys = Object.keys(publicMod)
	const internalKeys = new Set(Object.keys(internalMod))
	const missing = publicKeys.filter((key) => !internalKeys.has(key)).sort()
	expect(missing).toEqual([])
}
