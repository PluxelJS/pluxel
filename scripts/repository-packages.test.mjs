import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import { isPublishablePackage, tegamiIgnoredPackageNames } from './repository-packages.mjs'

const packageRecord = (kind, name, isPrivate) => ({
	kind,
	manifest: { name, ...(isPrivate === undefined ? {} : { private: isPrivate }) },
})

describe('repository package policy', () => {
	it('publishes only non-private packages and plugins', () => {
		assert.equal(isPublishablePackage(packageRecord('package', '@scope/library')), true)
		assert.equal(isPublishablePackage(packageRecord('plugin', '@scope/plugin', false)), true)
		assert.equal(isPublishablePackage(packageRecord('package', '@scope/internal', true)), false)
		assert.equal(isPublishablePackage(packageRecord('project', '@scope/app')), false)
		assert.equal(isPublishablePackage(packageRecord('root', 'workspace')), false)
	})

	it('derives Tegami ignores from the same publishability policy', () => {
		const packages = [
			packageRecord('plugin', '@scope/public-plugin'),
			packageRecord('package', '@scope/internal', true),
			packageRecord('project', '@scope/app', true),
			packageRecord('root', 'workspace', true),
		]

		assert.deepEqual(tegamiIgnoredPackageNames(packages), [
			'@scope/app',
			'@scope/internal',
			'workspace',
		])
	})
})
