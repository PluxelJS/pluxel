import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { repositoryPackages, isPublishablePackage } from '../../../scripts/repository-packages.mjs'
import { resolveDevSelection } from '@pluxel/agent-sdk/internal/client'

const packageRoot = resolve(import.meta.dirname, '..')
const bin = resolve(packageRoot, 'dist/create.mjs')
const execute = promisify(execFile)
let temporaryRoot

beforeAll(async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'create-pluxel-test-'))
})

afterAll(async () => {
	await rm(temporaryRoot, { recursive: true, force: true })
})

describe('create-pluxel', () => {
	it('ships an executable npm bin with help and package version', async () => {
		const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
		assert.deepEqual(manifest.bin, { 'create-pluxel': './dist/create.mjs' })
		assert.deepEqual(manifest.exports, { './package.json': './package.json' })
		assert.match(await readFile(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/)
		const binStat = await lstat(bin)
		assert.equal(binStat.mode & 0o111, 0o111)
		const [help, version] = await Promise.all([
			run([bin, '--help'], temporaryRoot),
			run([bin, '--version'], temporaryRoot),
		])
		assert.equal(help.code, 0)
		assert.match(help.stdout, /fixed Pluxel example monorepo/)
		assert.equal(version.code, 0)
		assert.equal(version.stdout.trim(), manifest.version)
	})

	it('generates a governed starter in an existing empty directory', async () => {
		const generated = resolve(temporaryRoot, 'starter')
		await mkdir(generated)
		const result = await run([bin, 'starter', '--no-install'], temporaryRoot)
		assert.equal(result.code, 0, result.stderr)

		const governance = await run(['scripts/check-workspace-governance.mjs'], generated)
		assert.equal(governance.code, 0, governance.stderr)
		assert.match(await readFile(resolve(generated, '.gitignore'), 'utf8'), /node_modules\//)
		const generatedManifest = JSON.parse(await readFile(resolve(generated, 'package.json'), 'utf8'))
		const repositoryManifest = JSON.parse(
			await readFile(resolve(packageRoot, '../../package.json'), 'utf8'),
		)
		assert.equal(generatedManifest.packageManager, repositoryManifest.packageManager)
		assert.equal(generatedManifest.scripts['hooks:install'], 'hk install')
		assert.equal(generatedManifest.name, undefined)
		assert.equal(generatedManifest.private, true)
		const { project: managed } = await resolveDevSelection({ root: generated })
		assert.equal(managed.profile, 'app')
		assert.equal(managed.pitchfork, 'app')
		assert.equal(managed.root, resolve(generated, 'host/web'))
		const { project: foreground } = await resolveDevSelection({ root: generated, profile: 'local' })
		assert.equal(foreground.root, managed.root)
		assert.equal(foreground.command, 'vp run @example/host#dev:server')
		assert.equal(generatedManifest.scripts['dev:local'], 'pluxel dev --profile local')
		for (const file of [
			'mise.toml',
			'hk.pkl',
			'pitchfork.toml',
			'vite.config.ts',
			'.github/workflows/ci.yml',
			'host/src/app.ts',
			'host/web/src/client/main.tsx',
		]) {
			assert.equal(
				await readFile(resolve(generated, file), 'utf8'),
				await readFile(resolve(packageRoot, 'template', file), 'utf8'),
				`${file} must reach the generated workspace unchanged`,
			)
		}
		assert.match(result.stdout, /vp install/)
		assert.match(result.stdout, /vp run setup/)
		assert.match(result.stdout, /vp run dev/)
		assert.match(result.stdout, /Application configuration: host\/src\/app\.ts/)
		assert.match(result.stdout, /vp run @example\/todo-plugin#check-tests tests\/plugin\.test\.ts/)

		assert.match(
			await readFile(resolve(generated, 'README.md'), 'utf8'),
			/https:\/\/github\.com\/PluxelJS\/pluxel\/blob\/main\/docs\/index\.md/,
		)
		for (const file of ['README.md', 'AGENTS.md']) {
			const contents = await readFile(resolve(generated, file), 'utf8')
			assert.match(contents, /development\/workspace-toolchain\.md/)
			for (const [, page] of contents.matchAll(
				/(?:docs\/pluxel\/|github\.com\/PluxelJS\/pluxel\/blob\/main\/docs\/)([\w/.-]+\.md)/g,
			)) {
				assert.ok(await readFile(resolve(packageRoot, '../../docs', page), 'utf8'), page)
			}
		}

		const generatedWorkspace = await readFile(resolve(generated, 'pnpm-workspace.yaml'), 'utf8')
		const source = await readFile(resolve(packageRoot, 'template/pnpm-workspace.yaml'), 'utf8')
		const catalog = /^  pluxel:\n(?: {4}[^\n]*\n)+/m
		const generatedCatalog = generatedWorkspace.match(catalog)?.[0]
		assert.ok(generatedCatalog)
		const versions = new Map(
			repositoryPackages
				.filter(isPublishablePackage)
				.map(({ manifest }) => [manifest.name, manifest.version]),
		)
		const ranges = [...generatedCatalog.matchAll(/^    '(@pluxel\/[^']+)': (.+)$/gm)]
		assert.ok(ranges.length > 0)
		for (const [, name, range] of ranges) {
			assert.ok(versions.has(name), `Unknown first-party catalog package: ${name}`)
			assert.equal(range, `^${versions.get(name)}`, name)
		}
		assert.equal(generatedWorkspace.replace(catalog, ''), source.replace(catalog, ''))
	})

	it('does not overwrite a non-empty destination', async () => {
		const destination = resolve(temporaryRoot, 'occupied')
		await mkdir(destination)
		const marker = resolve(destination, 'README.md')
		await writeFile(marker, 'Existing project\n')
		const result = await run([bin, 'occupied', '--no-install'], temporaryRoot)
		assert.notEqual(result.code, 0)
		assert.match(result.stderr, /Destination is not empty/)
		assert.equal(await readFile(marker, 'utf8'), 'Existing project\n')
	})

	it('rejects external dependency versions outside the named catalogs', async () => {
		const result = await run([bin, 'unmanaged-catalog', '--no-install'], temporaryRoot)
		assert.equal(result.code, 0, result.stderr)

		const generated = resolve(temporaryRoot, 'unmanaged-catalog')
		const manifestPath = resolve(generated, 'packages/domain/package.json')
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
		manifest.dependencies = { nanoid: '^5.1.6' }
		await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, '\t')}\n`)

		const governance = await run(['scripts/check-workspace-governance.mjs'], generated)
		assert.notEqual(governance.code, 0)
		assert.match(
			governance.stderr,
			/packages\/domain\/package\.json: dependencies\.nanoid must be governed by a catalog/,
		)
	})
})

async function run(args, cwd) {
	try {
		return { ...(await execute(process.execPath, args, { cwd, timeout: 4_000 })), code: 0 }
	} catch (error) {
		if (typeof error.code !== 'number') throw error
		return error
	}
}
