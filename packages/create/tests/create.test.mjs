import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, it } from 'vitest'
import pncatConfig from '../template/pncat.config.ts'
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
	it('routes common ecosystem dependencies into stable named catalogs', () => {
		assert.deepEqual(
			Object.fromEntries(
				[
					'@pluxel/test',
					'@heroui/react',
					'@tanstack/react-router',
					'lucide-react',
					'playwright',
					'@libsql/client',
					'graphql-yoga',
					'@types/qrcode',
					'electron-builder',
				].map((name) => [name, catalogFor(name)]),
			),
			{
				'@pluxel/test': 'pluxel',
				'@heroui/react': 'frontend',
				'@tanstack/react-router': 'frontend',
				'lucide-react': 'frontend',
				playwright: 'test',
				'@libsql/client': 'backend',
				'graphql-yoga': 'backend',
				'@types/qrcode': 'tooling',
				'electron-builder': 'tooling',
			},
		)
	})

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
		assert.equal(manifest.packageManager, 'pnpm@11.28.2')
		assert.equal(manifest.devDependencies['vite-plus'], 'catalog:tooling')
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
			'scripts/vite-tasks.ts',
			'host/src/app.ts',
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

		const webManifest = JSON.parse(
			await readFile(resolve(generated, 'host/web/package.json'), 'utf8'),
		)
		assert.equal(webManifest.name, '@example/web')
		assert.equal(webManifest.private, true)
		assert.deepEqual(webManifest.dependencies, {
			react: 'catalog:frontend',
			'react-dom': 'catalog:frontend',
		})
		assert.equal(manifest.devDependencies.pncat, undefined)
		assert.match(
			await readFile(resolve(generated, 'pncat.config.ts'), 'utf8'),
			/from '@pluxel\/cli\/pncat'/,
		)
		assert.match(await readFile(resolve(generated, 'pncat.config.ts'), 'utf8'), /name: 'pluxel'/)
		assert.doesNotMatch(
			await readFile(resolve(generated, 'host/web/src/client/main.tsx'), 'utf8'),
			/from ['"](?:@pluxel\/|@example\/)/,
		)
		const hostManifest = JSON.parse(await readFile(resolve(generated, 'host/package.json'), 'utf8'))
		assert.deepEqual(
			Object.fromEntries(
				Object.entries(hostManifest.dependencies).filter(([name]) => name.startsWith('@example/')),
			),
			{
				'@example/audit-plugin': 'workspace:*',
				'@example/http-plugin': 'workspace:*',
				'@example/todo-plugin': 'workspace:*',
			},
		)
		assert.equal(hostManifest.devDependencies['@example/web'], 'workspace:*')
		assert.match(
			await readFile(resolve(generated, 'host/tsdown.config.ts'), 'utf8'),
			/vite-plus\/pack/,
		)
		assert.match(
			await readFile(resolve(generated, 'host/vite.config.ts'), 'utf8'),
			/pack: packConfig/,
		)
		assert.equal(hostManifest.dependencies['@pluxel/runtime'], undefined)
		assert.equal(hostManifest.dependencies['@pluxel/host'], 'catalog:pluxel')
		assert.equal(hostManifest.dependencies['@pluxel/services'], 'catalog:pluxel')
		for (const plugin of ['audit', 'http', 'todo']) {
			const pluginManifest = JSON.parse(
				await readFile(resolve(generated, `plugins/${plugin}/package.json`), 'utf8'),
			)
			assert.deepEqual(
				Object.keys(pluginManifest.dependencies).filter((name) => name.startsWith('@pluxel/')),
				[],
			)
			const frameworkPeers = Object.keys(pluginManifest.peerDependencies).filter((name) =>
				name.startsWith('@pluxel/'),
			)
			assert.deepEqual(
				frameworkPeers,
				plugin === 'http' ? ['@pluxel/core', '@pluxel/services'] : ['@pluxel/core'],
			)
			for (const name of frameworkPeers) {
				assert.equal(pluginManifest.peerDependencies[name], 'catalog:pluxel')
				assert.equal(pluginManifest.devDependencies[name], 'catalog:pluxel')
			}
			assert.equal(pluginManifest.devDependencies.oxlint, undefined)
		}
		const viteConfig = await readFile(resolve(generated, 'host/vite.config.ts'), 'utf8')
		assert.match(viteConfig, /root: webRoot/)
		assert.equal(viteConfig.match(/\breact\(\)/g)?.length, 1)
		assert.match(viteConfig, /vitePreset\(\{ entry, devConsole: true \}\)/)
		assert.match(
			await readFile(resolve(generated, 'host/src/app.ts'), 'utf8'),
			/defineHostApplication\(async \(startup\) =>/,
		)
		await assert.rejects(readFile(resolve(generated, 'host/vite.dynamic.config.ts')), {
			code: 'ENOENT',
		})
		const webTasks = await readFile(resolve(generated, 'host/web/vite.config.ts'), 'utf8')
		assert.match(webTasks, /'check-types'/)
		assert.doesNotMatch(webTasks, /vitePreset|server:/)

		await assert.rejects(readFile(resolve(generated, 'docs/pluxel/index.md')), { code: 'ENOENT' })
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
		await assert.rejects(readFile(resolve(generated, '.pnpmfile.cjs')), { code: 'ENOENT' })
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

function catalogFor(packageName) {
	return [...pncatConfig.catalogRules]
		.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0))
		.find((rule) =>
			rule.match.some((matcher) =>
				typeof matcher === 'string' ? matcher === packageName : matcher.test(packageName),
			),
		)?.name
}

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
