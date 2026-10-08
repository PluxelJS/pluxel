import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { dependencyPolicy } from '../scripts/dependency-policy.mjs'
import {
	diagnoseWorkspaceDependencies,
	readDependencyPolicy,
	syncWorkspaceDependencies,
} from '../src/workspace/dependencies'
import type { DevelopmentSource } from '../src/workspace/setup'

const roots: string[] = []
const cliRoot = fileURLToPath(new URL('..', import.meta.url))
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(files: Record<string, string>) {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-policy-'))
	roots.push(root)
	for (const [name, contents] of Object.entries(files)) {
		await mkdir(dirname(resolve(root, name)), { recursive: true })
		await writeFile(resolve(root, name), contents)
	}
	return root
}

describe('workspace dependency policy', () => {
	it('uses the same catalog policy in Git and release resources and rejects ambiguous authority', async () => {
		const yaml =
			'catalogs:\n  prod: { yaml: ^2.9.1 }\n  peer: { yaml: ">=2" }\n  tooling: { yaml: ^2.9.1 }\n'
		const root = await fixture({
			'pnpm-workspace.yaml': yaml,
			'dist/resources/dependency-policy.json': JSON.stringify(dependencyPolicy(yaml)),
		})
		expect(readDependencyPolicy({ kind: 'git', root, version: '1' })).toEqual(
			readDependencyPolicy({ kind: 'release', root, version: '1' }),
		)
		expect(() =>
			dependencyPolicy('catalog: { yaml: ^2.0.0 }\ncatalogs: { prod: { yaml: ^3.0.0 } }'),
		).toThrow('Conflicting dependency policy for yaml')
	})

	it('checks without writing and explicitly applies pncat rules while preserving peer compatibility', async () => {
		const root = await fixture({
			'package.json': JSON.stringify({
				name: 'fixture',
				packageManager: 'pnpm@11.25.0',
				dependencies: { yaml: 'catalog:runtime' },
				peerDependencies: { yaml: '>=2' },
			}),
			'pnpm-workspace.yaml': 'packages: []\ncatalogs:\n  runtime:\n    yaml: ^2.0.0\n',
			'pncat.config.ts':
				"export default { catalogRules: [{ name: 'runtime', match: ['yaml'] }] }\n",
		})
		const policyRoot = await fixture({
			'dist/resources/dependency-policy.json': '{"yaml":"^2.9.1"}',
		})
		const source: DevelopmentSource = { kind: 'release', root: policyRoot, version: '1' }
		const before = await readFile(resolve(root, 'package.json'), 'utf8')
		const diagnostics = await diagnoseWorkspaceDependencies(root, source)
		expect(diagnostics.join('\n')).toContain('Dependency drift')
		expect(await readFile(resolve(root, 'package.json'), 'utf8')).toBe(before)
		expect(await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')).toBe(
			'packages: []\ncatalogs:\n  runtime:\n    yaml: ^2.0.0\n',
		)
		await syncWorkspaceDependencies(root, () => {}, source)
		expect(await readFile(resolve(root, 'package.json'), 'utf8')).toBe(before)
		const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
		expect(manifest.dependencies.yaml).toBe('catalog:runtime')
		expect(manifest.peerDependencies.yaml).toBe('>=2')
		expect(await diagnoseWorkspaceDependencies(root, source)).toEqual([])
	})

	it('runs the release artifact without a Git checkout or an external pncat installation', async () => {
		const root = await fixture({})
		const release = resolve(root, 'release')
		await mkdir(release)
		await cp(resolve(cliRoot, 'dist'), resolve(release, 'dist'), {
			recursive: true,
			filter: (path) => !path.endsWith('.map'),
		})
		await cp(resolve(cliRoot, 'bin'), resolve(release, 'bin'), { recursive: true })
		for (const name of ['LICENSE.md', 'UPSTREAM.md']) {
			expect(
				await readFile(resolve(release, 'dist/resources/third-party/pncat', name), 'utf8'),
			).toBe(await readFile(resolve(cliRoot, '../../vendor/pncat', name), 'utf8'))
		}
		const manifest = JSON.parse(await readFile(resolve(cliRoot, 'package.json'), 'utf8'))
		delete manifest.devDependencies
		delete manifest.peerDependencies
		await writeFile(resolve(release, 'package.json'), JSON.stringify(manifest))
		// Only declared runtime dependencies are installed; pncat must be bundled.
		for (const name of Object.keys(manifest.dependencies)) {
			const target = resolve(release, 'node_modules', name)
			await mkdir(dirname(target), { recursive: true })
			await symlink(await realpath(resolve(cliRoot, 'node_modules', name)), target)
		}
		const consumer = await fixture({
			'package.json':
				'{"name":"release-consumer","dependencies":{"yaml":"^2.0.0"},"peerDependencies":{"peer-only":"catalog:peer"}}',
			'packages/member/package.json': '{"name":"member","devDependencies":{"yaml":"^2.0.0"}}',
			'pnpm-workspace.yaml': 'packages: [packages/*]\ncatalogs:\n  peer:\n    peer-only: ^1.0.0\n',
			'pncat.config.ts':
				"import { defineConfig, mergeCatalogRules } from '@pluxel/cli/pncat'; export default defineConfig({ depFields: { peerDependencies: false }, catalogRules: mergeCatalogRules([{ name: 'runtime', match: ['yaml'], priority: 1000 }]) })\n",
		})
		const run = (...args: string[]) =>
			spawnSync(
				process.execPath,
				[resolve(release, 'bin/pluxel.mjs'), 'workspace', 'sync', '--root', consumer, ...args],
				{
					cwd: consumer,
					encoding: 'utf8',
					env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
				},
			)
		const native = (...args: string[]) =>
			spawnSync(process.execPath, [resolve(release, 'bin/pluxel.mjs'), 'pncat', ...args], {
				cwd: consumer,
				encoding: 'utf8',
				env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
			})
		const before = await readFile(resolve(consumer, 'package.json'), 'utf8')
		const check = run('--check')
		expect({ status: check.status, stderr: check.stderr }).toMatchObject({ status: 1 })
		expect(check.stderr).toContain('pluxel pncat migrate --yes --no-install')
		expect(await readFile(resolve(consumer, 'package.json'), 'utf8')).toBe(before)
		const rejected = run()
		expect(rejected.status).toBe(1)
		expect(await readFile(resolve(consumer, 'package.json'), 'utf8')).toBe(before)
		const detected = native('detect', '--yes')
		expect(detected.status).toBe(0) // Upstream detect reports drift; it is not a CI gate.
		expect(detected.stdout).toContain('pluxel pncat migrate')
		expect(await readFile(resolve(consumer, 'package.json'), 'utf8')).toBe(before)
		const migrated = native('migrate', '--yes', '--no-install')
		expect({ status: migrated.status, stderr: migrated.stderr }).toEqual({ status: 0, stderr: '' })
		const manifestPaths = ['package.json', 'packages/member/package.json']
		const migratedManifests = await Promise.all(
			manifestPaths.map((path) => readFile(resolve(consumer, path), 'utf8')),
		)
		const result = run()
		expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
		expect(
			await Promise.all(manifestPaths.map((path) => readFile(resolve(consumer, path), 'utf8'))),
		).toEqual(migratedManifests)
		const after = run('--check')
		expect({ status: after.status, stderr: after.stderr }).toEqual({ status: 0, stderr: '' })
		expect(
			readDependencyPolicy({ kind: 'release', root: release, version: manifest.version }),
		).toEqual(readDependencyPolicy())
		const help = native('--help')
		expect(help.status).toBe(0)
		expect(help.stdout).toContain('pncat/0.13.4')
		for (const args of [
			['remove', 'yaml', '--yes', '--no-install'],
			['add', 'yaml@^2.9.1', '--yes', '--no-install'],
		]) {
			const nativeResult = native(...args)
			expect({ status: nativeResult.status, stderr: nativeResult.stderr }).toEqual({
				status: 0,
				stderr: '',
			})
		}
		expect(
			JSON.parse(await readFile(resolve(consumer, 'package.json'), 'utf8')).dependencies.yaml,
		).toBe('catalog:runtime')
		const unused = await readFile(resolve(consumer, 'pnpm-workspace.yaml'), 'utf8')
		await writeFile(
			resolve(consumer, 'pnpm-workspace.yaml'),
			unused + '\ncatalog:\n  orphan: ^1.0.0\n',
		)
		const cleaned = native('clean', '--yes', '--no-install')
		expect({ status: cleaned.status, stderr: cleaned.stderr }).toEqual({ status: 0, stderr: '' })
		expect(await readFile(resolve(consumer, 'pnpm-workspace.yaml'), 'utf8')).not.toContain('orphan')
		expect(await readFile(resolve(consumer, 'pnpm-workspace.yaml'), 'utf8')).toContain('peer-only')
		// Actual package exports resolve at runtime and in an isolated TypeScript consumer.
		await mkdir(resolve(consumer, 'node_modules/@pluxel'), { recursive: true })
		await symlink(release, resolve(consumer, 'node_modules/@pluxel/cli'))
		const imported = spawnSync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				"import { defineConfig } from '@pluxel/cli/pncat'; console.log(defineConfig({ saveExact: false }).saveExact)",
			],
			{ cwd: consumer, encoding: 'utf8' },
		)
		expect({ status: imported.status, stdout: imported.stdout }).toEqual({
			status: 0,
			stdout: 'false\n',
		})
		await writeFile(
			resolve(consumer, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					target: 'ESNext',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					types: [],
				},
				files: ['pncat.config.ts'],
			}),
		)
		const fakeBin = resolve(root, 'fake-bin')
		await mkdir(fakeBin)
		await writeFile(
			resolve(fakeBin, 'pnpm'),
			'#!/bin/sh\necho install-fixture-failed >&2\nexit 42\n',
			{ mode: 0o755 },
		)
		const failedInstall = spawnSync(
			process.execPath,
			[resolve(release, 'bin/pluxel.mjs'), 'pncat', 'add', 'yaml@^2.9.2', '--yes'],
			{
				cwd: consumer,
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: `${fakeBin}:${process.env.PATH}`,
					NODE_OPTIONS: '',
					NODE_PATH: '',
				},
			},
		)
		expect(failedInstall.status).toBe(1)
		expect(failedInstall.stderr).toContain('install-fixture-failed')
		const standalone = await fixture({
			'package.json':
				'{"name":"standalone","packageManager":"pnpm@11.25.0","dependencies":{"yaml":"^2.9.1"}}',
		})
		const failedRemove = spawnSync(
			process.execPath,
			[resolve(release, 'bin/pluxel.mjs'), 'pncat', 'remove', 'yaml', '--yes'],
			{
				cwd: standalone,
				encoding: 'utf8',
				env: {
					...process.env,
					PATH: `${fakeBin}:${process.env.PATH}`,
					NODE_OPTIONS: '',
					NODE_PATH: '',
				},
			},
		)
		expect(failedRemove.status).toBe(1)
		expect(failedRemove.stderr).toContain('install-fixture-failed')
		await rm(resolve(consumer, 'pncat.config.ts'))
		const initialized = native('init', '--yes', '--no-install')
		expect({ status: initialized.status, stderr: initialized.stderr }).toEqual({
			status: 0,
			stderr: '',
		})
		expect(initialized.stdout).toContain('pluxel pncat migrate')
		expect(await readFile(resolve(consumer, 'pncat.config.ts'), 'utf8')).toContain(
			"from '@pluxel/cli/pncat'",
		)
		const tsc = spawnSync(
			process.execPath,
			[
				resolve(cliRoot, 'node_modules/typescript/bin/tsc'),
				'--project',
				resolve(consumer, 'tsconfig.json'),
			],
			{ cwd: consumer, encoding: 'utf8' },
		)
		expect({ status: tsc.status, stdout: tsc.stdout, stderr: tsc.stderr }).toEqual({
			status: 0,
			stdout: '',
			stderr: '',
		})
	}, 15_000)
})
