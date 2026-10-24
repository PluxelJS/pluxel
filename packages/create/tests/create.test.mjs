import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { repositoryPackages, isPublishablePackage } from '../../../scripts/repository-packages.mjs'
import { resolveDevProject } from '../../cli/src/dev/project'

const packageRoot = resolve(import.meta.dirname, '..')
const bin = resolve(packageRoot, 'dist/create.mjs')
let temporaryRoot

beforeAll(async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'create-pluxel-test-'))
})

afterAll(async () => {
	await rm(temporaryRoot, { recursive: true, force: true })
})

describe('create-pluxel', () => {
	it('builds a typed single-file npm CLI boundary with tsdown', async () => {
		const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
		assert.deepEqual(manifest.bin, { 'create-pluxel': './dist/create.mjs' })
		assert.deepEqual(manifest.exports, { './package.json': './package.json' })
		assert.match(await readFile(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/)
		const binStat = await lstat(bin)
		assert.equal(binStat.mode & 0o111, 0o111)
	})

	it('copies the fixed starter with governed tooling and canonical documentation links', async () => {
		const result = await run([bin, 'starter', '--no-install'], temporaryRoot)
		assert.equal(result.code, 0, result.stderr)

		const generated = resolve(temporaryRoot, 'starter')
		const governance = await run(['scripts/check-workspace-governance.mjs'], generated)
		assert.equal(governance.code, 0, governance.stderr)
		assert.match(await readFile(resolve(generated, '.gitignore'), 'utf8'), /node_modules\//)
		const manifest = JSON.parse(await readFile(resolve(generated, 'package.json'), 'utf8'))
		assert.equal(manifest.name, undefined)
		assert.equal(manifest.private, true)
		const managed = await resolveDevProject({ root: generated })
		assert.equal(managed.profile, 'app')
		assert.equal(managed.pitchfork, 'app')
		assert.equal(managed.root, resolve(generated, 'host/web'))
		const foreground = await resolveDevProject({ root: generated, profile: 'local' })
		assert.equal(foreground.root, managed.root)
		assert.equal(foreground.command, 'vp run @example/host#dev:server')
		assert.equal(manifest.scripts['dev:local'], 'pluxel dev --profile local')
		for (const file of [
			'mise.toml',
			'hk.pkl',
			'pitchfork.toml',
			'vite.config.ts',
			'oxlint.config.ts',
			'oxfmt.config.ts',
			'.github/workflows/ci.yml',
			'scripts/vite-tasks.ts',
			'pncat.config.ts',
			'host/src/app.ts',
			'host/vite.config.ts',
			'host/web/vite.config.ts',
			'host/web/src/client/main.tsx',
		]) {
			assert.equal(
				await readFile(resolve(generated, file), 'utf8'),
				await readFile(resolve(packageRoot, 'template', file), 'utf8'),
				`${file} must reach the generated workspace unchanged`,
			)
		}
		assert.match(result.stdout, /mise trust/)
		assert.match(result.stdout, /vp run setup/)
		assert.match(result.stdout, /vp run dev/)

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
	})

	it('emits first-party catalog ranges from the actual publishable package versions', async () => {
		const generated = await readFile(resolve(temporaryRoot, 'starter/pnpm-workspace.yaml'), 'utf8')
		const source = await readFile(resolve(packageRoot, 'template/pnpm-workspace.yaml'), 'utf8')
		const catalog = /^  pluxel:\n(?: {4}[^\n]*\n)+/m
		const generatedCatalog = generated.match(catalog)?.[0]
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
		assert.equal(generated.replace(catalog, ''), source.replace(catalog, ''))
	})

	it('does not overwrite a non-empty destination', async () => {
		const result = await run([bin, 'starter', '--no-install'], temporaryRoot)
		assert.notEqual(result.code, 0)
		assert.match(result.stderr, /Destination is not empty/)
	})

	it('accepts an existing empty destination', async () => {
		await mkdir(resolve(temporaryRoot, 'empty'))
		const result = await run([bin, 'empty', '--no-install'], temporaryRoot)
		assert.equal(result.code, 0, result.stderr)
		assert.equal(
			JSON.parse(await readFile(resolve(temporaryRoot, 'empty/package.json'), 'utf8')).private,
			true,
		)
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

	it('exposes help and package version without loading the CLI', async () => {
		const [help, version] = await Promise.all([
			run([bin, '--help'], temporaryRoot),
			run([bin, '--version'], temporaryRoot),
		])
		assert.equal(help.code, 0)
		assert.match(help.stdout, /fixed Pluxel example monorepo/)
		assert.equal(version.code, 0)
		assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/)
	})
})

async function run(args, cwd) {
	return await new Promise((accept, reject) => {
		const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
		child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
		child.once('error', reject)
		child.once('exit', (code, signal) => accept({ code, signal, stdout, stderr }))
	})
}
