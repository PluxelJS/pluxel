import { createHash } from 'node:crypto'
import {
	lstat,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	readlink,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import {
	normalizeRepositoryIdentity,
	parseSourceProjectConfig,
	readSourceCheckoutRegistry,
} from '../src/source/config'
import {
	createPnpmInvocation,
	createSourceBuildArgs,
	createSourceInstallArgs,
	ensureSourcePnpmfileBootstrap,
	materializeSourceOverrides,
	sourcePnpmfileBootstrapContents,
} from '../src/source/execution'
import {
	createSourceWorkspacePlan,
	type ResolvedSourceCheckout,
	sourceCheckoutInstallOverrides,
} from '../src/source/plan'
import { registerSourceCheckout } from '../src/source/registry'
import { sourcePackageNeedsBuild } from '../src/source/workspace'

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	)
})

describe('source workspace configuration', () => {
	it('normalizes common Git remote forms to one stable identity', () => {
		expect(normalizeRepositoryIdentity('git@github.com:PluxelJS/pluxel.git')).toBe(
			'https://github.com/PluxelJS/pluxel',
		)
		expect(normalizeRepositoryIdentity('git+https://github.com/PluxelJS/pluxel/')).toBe(
			'https://github.com/PluxelJS/pluxel',
		)
		expect(normalizeRepositoryIdentity('ssh://git@git.example.com:8443/acme/repo.git')).toBe(
			'https://git.example.com:8443/acme/repo',
		)
	})

	it('parses JSONC strictly and rejects duplicate semantic sources', () => {
		expect(
			parseSourceProjectConfig(`{
				// machine paths deliberately do not belong here
				"version": 1,
				"sources": ["https://github.com/PluxelJS/pluxel.git"],
			}`),
		).toEqual({
			version: 1,
			sources: ['https://github.com/PluxelJS/pluxel'],
			singletons: [],
		})
		expect(() =>
			parseSourceProjectConfig(
				'{"version":1,"sources":["git@github.com:PluxelJS/pluxel.git","https://github.com/PluxelJS/pluxel"]}',
			),
		).toThrow(/duplicate/i)
		expect(() =>
			parseSourceProjectConfig('{"version":1,"sources":["github.com/acme/repo"],"path":".."}'),
		).toThrow(/unknown field.*path/i)
	})

	it('atomically registers an absolute checkout by repository identity', async () => {
		const root = await createTemporaryRoot()
		const registryPath = resolve(root, 'config/source-checkouts.json')
		registerSourceCheckout({
			registryPath,
			repository: 'git@github.com:PluxelJS/pluxel.git',
			checkoutRoot: resolve(root, 'checkouts/pluxel'),
		})
		expect(readSourceCheckoutRegistry(registryPath)).toEqual({
			version: 1,
			checkouts: {
				'https://github.com/PluxelJS/pluxel': resolve(root, 'checkouts/pluxel'),
			},
		})
	})
})

describe('source workspace planning', () => {
	it('discovers transitive checkouts and derives only the consumed package closure', async () => {
		const root = await createTemporaryRoot()
		const upstream = resolve(root, 'upstream')
		const middle = resolve(root, 'middle')
		const consumer = resolve(root, 'consumer')
		await createWorkspace(upstream, {
			'a/package.json': {
				name: '@acme/a',
				version: '1.0.0',
				scripts: { build: 'build-a' },
				devDependencies: { '@acme/unused': '^1.0.0' },
			},
			'unused/package.json': { name: '@acme/unused', version: '1.0.0' },
		})
		await createWorkspace(
			middle,
			{
				'b/package.json': {
					name: '@acme/b',
					version: '1.0.0',
					peerDependencies: { '@acme/a': '^1.0.0' },
				},
			},
			['https://github.com/acme/upstream'],
		)
		await createWorkspace(
			consumer,
			{
				'app/package.json': {
					name: '@acme/app',
					version: '1.0.0',
					dependencies: { '@acme/b': '^1.0.0' },
				},
			},
			['https://github.com/acme/middle'],
		)
		const registryPath = resolve(root, 'source-checkouts.json')
		await writeJson(registryPath, {
			version: 1,
			checkouts: {
				'https://github.com/acme/upstream': upstream,
				'https://github.com/acme/middle': middle,
			},
		})

		const plan = await createSourceWorkspacePlan({ root: consumer, registryPath })
		expect(plan.checkouts.map((checkout) => checkout.repository)).toEqual([
			'https://github.com/acme/upstream',
			'https://github.com/acme/middle',
		])
		expect(plan.selectedPackages.map((pkg) => pkg.name)).toEqual(['@acme/a', '@acme/b'])
		expect(plan.overrides).toEqual({
			'@acme/a': `link:${resolve(upstream, 'a')}`,
			'@acme/b': `link:${resolve(middle, 'b')}`,
		})
		expect(sourceCheckoutInstallOverrides(plan.checkouts[1]!, plan)).toEqual({
			'@acme/a': `link:${resolve(upstream, 'a')}`,
		})
		expect(plan.overrides).not.toHaveProperty('@acme/unused')
	})

	it('fails before pnpm resolves private source packages when the overlay is absent', async () => {
		const root = await createTemporaryRoot()
		ensureSourcePnpmfileBootstrap(root)
		const written = await readFile(resolve(root, '.pnpmfile.cjs'), 'utf8')
		const bootstrap = sourcePnpmfileBootstrapContents()
		expect(written).toBe(bootstrap)
		expect(bootstrap).toContain('Source overlay is missing')
		expect(bootstrap).toContain('source-local-project.mjs')
		expect(bootstrap).not.toContain('{ hooks: {} }')
	})

	it('derives install and build commands from source artifact contracts', () => {
		expect(createSourceInstallArgs({ '@acme/app': 'link:/src/app' })).toEqual(['install'])
		expect(createSourceInstallArgs({})).toEqual(['install', '--frozen-lockfile'])
		expect(createPnpmInvocation('pnpm@11.12.0', ['install'])).toEqual({
			command: 'corepack',
			args: ['pnpm', 'install'],
		})
		expect(() => createPnpmInvocation('npm@11.0.0', ['install'])).toThrow(/require pnpm/i)

		expect(
			sourcePackageNeedsBuild({
				scripts: { build: 'vite build' },
				exports: { '.': './src/index.ts' },
			}),
		).toBe(false)
		expect(
			sourcePackageNeedsBuild({
				scripts: { build: 'tsdown' },
				exports: { '.': { '@pluxel/source': './src/index.ts', default: './dist/index.mjs' } },
			}),
		).toBe(true)
		expect(sourcePackageNeedsBuild({ scripts: { build: 'tsdown' }, bin: './bin/cli.mjs' })).toBe(
			true,
		)
		expect(createSourceBuildArgs(['@acme/app'], true)).toEqual([
			'exec',
			'turbo',
			'run',
			'build',
			'--force',
			'--dangerously-disable-package-manager-check',
			'--filter=@acme/app',
		])
		expect(createSourceBuildArgs(['@acme/app'], false)).toEqual([
			'--filter',
			'@acme/app...',
			'--if-present',
			'run',
			'build',
		])
	})

	it('includes a source workspace root and resolves singletons from selected owners only', async () => {
		const root = await createTemporaryRoot()
		const source = resolve(root, 'source')
		const consumer = resolve(root, 'consumer')
		await createWorkspace(source, {
			'unused/package.json': {
				name: '@acme/unused',
				version: '1.0.0',
				dependencies: { 'drizzle-orm': '^0.45.0' },
			},
		})
		await writeJson(resolve(source, 'package.json'), {
			name: '@acme/root-package',
			version: '1.0.0',
			dependencies: { 'drizzle-orm': '^0.45.0' },
		})
		await createWorkspace(consumer, {
			'app/package.json': {
				name: '@acme/app',
				version: '1.0.0',
				dependencies: { '@acme/root-package': '^1.0.0' },
			},
		})
		await writeJson(resolve(consumer, 'pluxel.sources.jsonc'), {
			version: 1,
			sources: ['https://github.com/acme/source'],
			singletons: ['drizzle-orm'],
		})
		const registryPath = resolve(root, 'source-checkouts.json')
		await writeJson(registryPath, {
			version: 1,
			checkouts: { 'https://github.com/acme/source': source },
		})

		const plan = await createSourceWorkspacePlan({ root: consumer, registryPath })
		expect(plan.selectedPackages.map((pkg) => pkg.name)).toEqual(['@acme/root-package'])
		expect(plan.overrides).toEqual({
			'@acme/root-package': `link:${source}`,
			'drizzle-orm': `link:${resolve(source, 'node_modules/drizzle-orm')}`,
		})
	})

	it('uses the most specific checkout and a stable proxy when repositories are nested', async () => {
		const root = await createTemporaryRoot()
		const parent = resolve(root, 'parent')
		const consumer = resolve(parent, 'local-projects/consumer')
		const child = resolve(parent, 'local-projects/child')
		const childPackage = resolve(child, 'packages/example')
		const childRepository = 'https://github.com/acme/child'
		await Promise.all([
			mkdir(consumer, { recursive: true }),
			mkdir(childPackage, { recursive: true }),
		])
		const legacyProxy = resolve(
			consumer,
			'.pluxel/sources',
			createHash('sha256').update(childRepository).digest('hex').slice(0, 12),
		)
		await mkdir(resolve(legacyProxy, '..'), { recursive: true })
		await symlink(child, legacyProxy, process.platform === 'win32' ? 'junction' : 'dir')
		const checkouts: ResolvedSourceCheckout[] = [
			{
				repository: 'https://github.com/acme/parent',
				root: parent,
				workspace: {} as never,
				sources: [],
				singletons: [],
			},
			{
				repository: childRepository,
				root: child,
				workspace: {} as never,
				sources: [],
				singletons: [],
			},
		]
		const stable = materializeSourceOverrides(
			consumer,
			{ '@acme/example': `link:${childPackage}` },
			checkouts,
		)
		expect(stable['@acme/example']).toMatch(
			/^link:\.pluxel\/sources\/[a-f\d]{12}\/acme\+example-[a-f\d]{12}$/,
		)
		const repositories = await readdir(resolve(consumer, '.pluxel/sources'))
		expect(repositories).toHaveLength(1)
		const repositoryProxy = resolve(consumer, '.pluxel/sources', repositories[0]!)
		const repositoryStat = await lstat(repositoryProxy)
		expect(repositoryStat.isDirectory()).toBe(true)
		const packages = await readdir(repositoryProxy)
		expect(packages).toHaveLength(1)
		expect(resolve(repositoryProxy, await readlink(resolve(repositoryProxy, packages[0]!)))).toBe(
			childPackage,
		)

		const movedPackage = resolve(child, 'modules/example')
		await mkdir(movedPackage, { recursive: true })
		const movedStable = materializeSourceOverrides(
			consumer,
			{ '@acme/example': `link:${movedPackage}` },
			checkouts,
		)
		expect(movedStable).toEqual(stable)
		expect(resolve(repositoryProxy, await readlink(resolve(repositoryProxy, packages[0]!)))).toBe(
			movedPackage,
		)
	})

	it('rejects a source package that contains the consumer workspace', async () => {
		const root = await createTemporaryRoot()
		const sourcePackage = resolve(root, 'source')
		const consumer = resolve(sourcePackage, 'local-projects/consumer')
		await mkdir(consumer, { recursive: true })

		expect(() =>
			materializeSourceOverrides(consumer, { '@acme/source': `link:${sourcePackage}` }, [
				{
					repository: 'https://github.com/acme/source',
					root: sourcePackage,
					workspace: {} as never,
					sources: [],
					singletons: [],
				},
			]),
		).toThrow(/contains the consumer workspace/i)
	})
})

async function createTemporaryRoot() {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-source-test-'))
	temporaryRoots.push(root)
	return root
}

async function createWorkspace(
	root: string,
	packages: Record<string, Record<string, unknown>>,
	sources?: string[],
) {
	await writeJson(resolve(root, 'package.json'), {
		name: `fixture-${root.split('/').at(-1)}`,
		private: true,
	})
	await writeFile(resolve(root, 'pnpm-workspace.yaml'), "packages:\n  - '*'\n", 'utf8')
	for (const [path, manifest] of Object.entries(packages)) {
		await writeJson(resolve(root, path), manifest)
	}
	if (sources) {
		await writeJson(resolve(root, 'pluxel.sources.jsonc'), { version: 1, sources })
	}
}

async function writeJson(path: string, value: unknown) {
	await mkdir(resolve(path, '..'), { recursive: true })
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
