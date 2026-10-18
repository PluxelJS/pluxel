import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { tegami } from 'tegami'
import { parse } from 'yaml'
import { unifiedReleaseVersions } from './release-policy.mts'

import {
	isPublishablePackage,
	rootWorkspaceDependencyErrors,
	packagesRequiringInitialMajor,
	releasePackageErrors,
	tegamiIgnorePattern,
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

	it('limits Tegami to public inventory names and their npm IDs', () => {
		const packages = [
			packageRecord('plugin', '@scope/public-plugin'),
			packageRecord('package', 'literal.name'),
			packageRecord('package', '@scope/internal', true),
			packageRecord('project', '@scope/app', true),
			packageRecord('root', 'workspace', true),
		]

		const ignored = tegamiIgnorePattern(packages)
		for (const name of ['@scope/public-plugin', 'literal.name']) {
			assert.equal(ignored.test(name), false)
			assert.equal(ignored.test(`npm:${name}`), false)
		}
		for (const name of [
			'@scope/app',
			'@scope/internal',
			'workspace',
			'eventure',
			'@worksplit/core',
			'@pluxel-internal/pncat',
			'unknown-fixture',
			'literalXname',
			'@scope/public-plugin-extra',
		]) {
			assert.equal(ignored.test(name), true)
			assert.equal(ignored.test(`npm:${name}`), true)
		}
		assert.equal(tegamiIgnorePattern([]).test('anything'), true)
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

	it('enforces official Plugin names and the stable Core version while admitting new pre-1 packages', () => {
		const core = packageRecord('package', '@pluxel/core', undefined, '1.2.0')
		assert.deepEqual(
			releasePackageErrors([
				core,
				packageRecord('plugin', '@pluxel/plugin-new', undefined, '0.1.0'),
				packageRecord('plugin', '@pluxel/plugin-private', true, '0.0.0'),
				packageRecord('project', 'example', true, '0.1.0'),
			]),
			[],
		)
		const errors = releasePackageErrors([
			core,
			packageRecord('plugin', '@pluxel/old', true, '0.0.0'),
			packageRecord('package', 'valibot-form', undefined, '1.1.0'),
		])
		assert.equal(errors.length, 2)
		assert.match(errors[0], /@pluxel\/plugin-xxx/)
		assert.match(errors[1], /must match Core 1\.2\.0/)
	})
})

describe('native Tegami unified release versions', () => {
	it('treats a new package initial major as a group minor without discarding its intent', async () => {
		await releaseFixture(
			'1.2.0',
			'0.1.0',
			{
				'patch.md': note('@pluxel/core', 'patch'),
				'new.md': note('@pluxel/plugin-new', 'major'),
			},
			async (paper, root) => {
				const draft = await paper.draft()
				assert.equal(draft.getPackageDraft('npm:@pluxel/plugin-new').type, 'major')
				assert.equal(
					draft
						.getChangelogs()
						.find((entry) => entry.filename === 'new.md')
						.packages.get('@pluxel/plugin-new').type,
					'major',
				)
				await draft.apply()
				assert.deepEqual(await fixtureVersions(root), ['1.3.0', '1.3.0', '1.3.0'])
			},
		)
	})

	it('retains genuine stable-package major changes across the complete group', async () => {
		await releaseFixture(
			'1.2.0',
			'0.1.0',
			{
				'breaking.md': note('@pluxel/plugin-existing', 'major'),
				'new.md': note('@pluxel/plugin-new', 'major'),
			},
			async (paper, root) => {
				const draft = await paper.draft()
				await draft.apply()
				assert.deepEqual(await fixtureVersions(root), ['2.0.0', '2.0.0', '2.0.0'])
			},
		)
	})

	it('consumes the explicit release once, preserves breaking text and then advances by patch', async () => {
		const breaking = note(
			'@pluxel/plugin-existing',
			'major',
			'Remove the previous API; migrate to the explicit owner.',
		)
		await releaseFixture(
			'1.1.0',
			'0.1.0',
			{
				'breaking.md': breaking,
				'new.md': note('@pluxel/plugin-new', 'major'),
				'release-1.2.0.md': note('@pluxel/core', 'minor'),
			},
			async (paper, root) => {
				const draft = await paper.draft()
				await draft.apply()
				assert.deepEqual(await fixtureVersions(root), ['1.2.0', '1.2.0', '1.2.0'])
				const files = await readdir(join(root, '.tegami'))
				assert.deepEqual(files, ['publish-lock.yaml'])
				const lock = parse(await readFile(join(root, '.tegami/publish-lock.yaml'), 'utf8'))
				assert.equal(
					lock['core:changelogs']
						.find((entry) => entry.filename === 'breaking.md')
						.content.includes('Remove the previous API; migrate to the explicit owner.'),
					true,
				)
				assert.equal(
					lock['core:changelogs']
						.find((entry) => entry.filename === 'breaking.md')
						.content.includes('type: major'),
					true,
				)
				const unchanged = await paper.draft()
				assert.equal(unchanged.hasPending(), false)
				await writeFile(join(root, '.tegami/next.md'), note('@pluxel/core', 'patch'))
				const next = await paper.draft()
				await next.apply()
				assert.deepEqual(await fixtureVersions(root), ['1.2.1', '1.2.1', '1.2.1'])
			},
		)
	})

	it('does not create a release merely because a new pre-1 package exists', async () => {
		await releaseFixture('1.2.0', '0.1.0', {}, async (paper, root) => {
			const draft = await paper.draft()
			assert.equal(draft.hasPending(), false)
			assert.deepEqual(await fixtureVersions(root), ['1.2.0', '1.2.0', '0.1.0'])
			assert.deepEqual(await readdir(join(root, '.tegami')), [])
		})
	})

	it.each([
		['release-1.2.md', /Invalid release target/],
		['release-01.2.0.md', /Invalid release target/],
		['release-9007199254740992.0.0.md', /Invalid release target/],
		['release-1.2.0.md', /must exceed Core/],
		['release-1.1.0.md', /must exceed Core/],
	])('rejects invalid, repeated or backward target %s', async (filename, expected) => {
		await releaseFixture(
			'1.2.0',
			'0.1.0',
			{ [filename]: note('@pluxel/core', 'minor') },
			async (paper) => {
				await assert.rejects(paper.draft(), expected)
			},
		)
	})

	it('rejects competing target instructions', async () => {
		await releaseFixture(
			'1.1.0',
			'0.1.0',
			{
				'release-1.2.0.md': note('@pluxel/core', 'minor'),
				'release-1.3.0.md': note('@pluxel/core', 'minor'),
			},
			async (paper) => {
				await assert.rejects(paper.draft(), /Only one pending release target/)
			},
		)
	})
})

const fixtureNames = ['@pluxel/core', '@pluxel/plugin-existing', '@pluxel/plugin-new']

function note(name, type, body = 'Keep the documented behavior.') {
	return `---\npackages:\n  '${name}': ${type}\n---\n\n## Release change\n\n${body}\n`
}

async function releaseFixture(version, newVersion, notes, run) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-release-policy-'))
	try {
		await mkdir(join(root, '.tegami'))
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'release-fixture',
				private: true,
				packageManager: 'pnpm@11.28.2',
				workspaces: ['packages/*'],
			}),
		)
		for (const [index, name] of fixtureNames.entries()) {
			const directory = join(root, 'packages', String(index))
			await mkdir(directory, { recursive: true })
			await writeFile(
				join(directory, 'package.json'),
				JSON.stringify({ name, version: index === 2 ? newVersion : version }),
			)
		}
		for (const [filename, source] of Object.entries(notes))
			await writeFile(join(root, '.tegami', filename), source)
		const paper = tegami({
			cwd: root,
			ignore: ['release-fixture'],
			npm: { client: 'pnpm', updateLockFile: false },
			groups: { pluxel: { syncBump: true, syncGitTag: true } },
			packages: Object.fromEntries(fixtureNames.map((name) => [name, { group: 'pluxel' }])),
			plugins: [unifiedReleaseVersions()],
		})
		await run(paper, root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}

async function fixtureVersions(root) {
	return Promise.all(
		fixtureNames.map(
			async (_, index) =>
				JSON.parse(await readFile(join(root, 'packages', String(index), 'package.json'), 'utf8'))
					.version,
		),
	)
}

describe('root workspace dependency ownership', () => {
	it('rejects vendor workspace dependencies absent from the release inventory', () => {
		assert.deepEqual(
			rootWorkspaceDependencyErrors({ devDependencies: { pncat: 'workspace:*' } }, []),
			[
				'root devDependencies.pncat must be owned by its consuming package; declare it in its consumer package',
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
