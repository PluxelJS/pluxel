import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'

import {
	isPublishablePackage,
	rootWorkspaceDependencyErrors,
	packagesRequiringInitialMajor,
	tegamiIgnoredPackageNames,
	readRepositoryPackages,
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
	it('includes the embedded launcher SDK without discovering arbitrary nested projects', async () => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-inventory-'))
		try {
			for (const directory of [
				'projects/embedded-launcher',
				'projects/embedded-launcher/sdk',
				'projects/embedded-launcher/unrelated',
			]) {
				await mkdir(join(root, directory), { recursive: true })
				await writeFile(
					join(root, directory, 'package.json'),
					JSON.stringify({ name: directory, private: true }),
				)
			}
			const packages = await readRepositoryPackages(root)
			assert.deepEqual(packages.map(({ directory }) => directory).sort(), [
				'projects/embedded-launcher',
				'projects/embedded-launcher/sdk',
			])
			assert.ok(packages.every(({ kind }) => kind === 'project'))
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
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

describe('root workspace dependency ownership', () => {
	it('rejects vendor workspace dependencies absent from the release inventory', () => {
		assert.deepEqual(
			rootWorkspaceDependencyErrors({ devDependencies: { pncat: 'workspace:*' } }, []),
			[
				'root devDependencies.pncat invalidates every Turbo task; declare it in its consumer package',
			],
		)
	})
	it('rejects known workspace names even with a normal range and permits registry tools', () => {
		const errors = rootWorkspaceDependencyErrors(
			{ devDependencies: { '@scope/tool': '^1.0.0', vitest: 'catalog:test' } },
			[packageRecord('package', '@scope/tool')],
		)
		assert.equal(errors.length, 1)
		assert.match(errors[0], /@scope\/tool/)
	})
})
