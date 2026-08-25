import assert from 'node:assert/strict'
import { describe, it } from 'vitest'

import {
	isPublishablePackage,
	packagesRequiringInitialMajor,
	tegamiIgnoredPackageNames,
} from './repository-packages.mjs'

const packageRecord = (kind, name, isPrivate, version) => ({
	kind,
	manifest: {
		name,
		...(isPrivate === undefined ? {} : { private: isPrivate }),
		...(version === undefined ? {} : { version }),
	},
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

	it('requires an atomic first major, then only majors newly added pre-1 packages', () => {
		const firstRelease = [
			packageRecord('package', '@scope/a', undefined, '0.1.0'),
			packageRecord('plugin', '@scope/b', undefined, '0.8.0'),
		]
		assert.deepEqual(packagesRequiringInitialMajor(firstRelease), firstRelease)

		const laterAddition = [
			packageRecord('package', '@scope/a', undefined, '1.2.0'),
			packageRecord('plugin', '@scope/new', undefined, '0.1.0'),
		]
		assert.deepEqual(packagesRequiringInitialMajor(laterAddition), [laterAddition[1]])
		assert.deepEqual(
			packagesRequiringInitialMajor([packageRecord('package', '@scope/a', undefined, '1.2.0')]),
			[],
		)
	})
})
