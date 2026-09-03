import { describe, expect, it } from 'vitest'
import {
	createPackageManagerDynamicFixture,
	runPackageManagerDynamicFixture,
} from './support/dynamic-runtime.ts'

describe('PackageManagerPlugin dynamic source contract', () => {
	it('fails before side effects when the declared directory has a mismatched include', async () => {
		await using fixture = await createPackageManagerDynamicFixture('*.js')

		await expect(runPackageManagerDynamicFixture(fixture, false)).resolves.toBeUndefined()
	}, 90_000)
})
