import { describe, expect, it } from 'vitest'
import {
	createPackageManagerDynamicFixture,
	runPackageManagerDynamicFixture,
} from './support/dynamic-runtime.ts'

describe('PackageManagerPlugin dynamic host', () => {
	it('starts when the host declares its exact publication directory', async () => {
		await using fixture = await createPackageManagerDynamicFixture('*.mjs')

		await expect(runPackageManagerDynamicFixture(fixture, true)).resolves.toBeUndefined()
	}, 90_000)
})
