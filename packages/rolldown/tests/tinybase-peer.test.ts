import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { rolldown } from 'rolldown'
import { afterEach, expect, it } from 'vitest'
import { collectTinybaseConsumers, validateTinybasePeer } from '../src/cli/tinybase-peer'
import { createPluginDependencyMetadataHook } from '../src/cli/plugin-metadata'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(
	options: { peer?: string; dev?: string; installed?: string; source?: string } = {},
) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-tinybase-peer-'))
	roots.push(root)
	const put = async (path: string, value: unknown) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value))
	}
	await put('pnpm-workspace.yaml', 'catalogs:\n  prod:\n    tinybase: 10.0.1\n')
	await put('node_modules/@pluxel/services/package.json', {
		name: '@pluxel/services',
		peerDependencies: { tinybase: '10.0.1' },
		exports: { './package.json': './package.json' },
	})
	for (const [path, version] of [
		['node_modules/@pluxel/services/node_modules/tinybase', '10.0.1'],
		['plugin/node_modules/tinybase', options.installed ?? '10.0.1'],
	]) {
		await put(`${path}/package.json`, {
			name: 'tinybase',
			version,
			type: 'module',
			exports: './index.mjs',
		})
		await put(`${path}/index.mjs`, 'export const createStore = () => ({})')
	}
	await put('plugin/package.json', {
		name: '@fixture/store',
		version: '1.0.0',
		peerDependencies: options.peer ? { tinybase: options.peer } : {},
		devDependencies: options.dev ? { tinybase: options.dev } : {},
	})
	await put(
		'plugin/index.ts',
		options.source ?? "export { TinyBase } from '@pluxel/services/tinybase'",
	)
	return {
		root,
		packageJsonPath: join(root, 'plugin/package.json'),
		entry: join(root, 'plugin/index.ts'),
	}
}

it('accepts exact catalog declarations and an independent same-version install without requiring the Services runtime build', async () => {
	const { packageJsonPath } = await fixture({ peer: 'catalog:prod', dev: 'catalog:prod' })
	await expect(validateTinybasePeer(packageJsonPath)).resolves.toBe('10.0.1')
})

it('rejects an unsupported service installation even when all consumers agree with that installed version', async () => {
	const { root, packageJsonPath } = await fixture({
		peer: '10.1.0',
		dev: '10.1.0',
		installed: '10.1.0',
	})
	const manifest = join(root, 'node_modules/@pluxel/services/node_modules/tinybase/package.json')
	const installed = JSON.parse(await readFile(manifest, 'utf8'))
	await writeFile(manifest, JSON.stringify({ ...installed, version: '10.1.0' }))
	await expect(validateTinybasePeer(packageJsonPath)).rejects.toThrow(
		/@pluxel\/services.*peerDependencies.tinybase 10\.0\.1.*resolved 10\.1\.0.*Host TinyBase supports 10\.0\.1/,
	)
})

it.each([
	[{ dev: '10.0.1' }, /peerDependencies.tinybase <missing>/],
	[{ peer: '^10.0.1', dev: '10.0.1' }, /peerDependencies.tinybase \^10\.0\.1/],
	[{ peer: '10.0.1' }, /devDependencies.tinybase <missing>/],
	[{ peer: '10.0.1', dev: '10.0.1', installed: '10.1.0' }, /resolved 10\.1\.0/],
] as const)(
	'rejects incorrect source declarations or installed bytes: %j',
	async (options, diagnostic) => {
		const { packageJsonPath } = await fixture(options)
		await expect(validateTinybasePeer(packageJsonPath)).rejects.toThrow(diagnostic)
	},
)

it.each([
	["export { TinyBase } from '@pluxel/services/tinybase'", true],
	["export const service = import('@pluxel/services/tinybase')", true],
	["import type { TinyBase } from '@pluxel/services/tinybase'; export const result = 1", false],
	["import { type TinyBase } from '@pluxel/services/tinybase'; export const result = 1", false],
	["export { createStore } from 'tinybase'", false],
] as const)('derives capability use from actual runtime imports: %s', async (source, expected) => {
	const { packageJsonPath, entry } = await fixture({ source })
	const collector = collectTinybaseConsumers(packageJsonPath)
	const bundle = await rolldown({
		input: entry,
		external: [/^@pluxel\//, /^tinybase/],
		plugins: [collector.plugin],
	})
	try {
		await bundle.generate({ format: 'esm' })
		expect(collector.usesTinybase()).toBe(expected)
	} finally {
		await bundle.close()
	}
})

it('generates and withdraws the TinyBase capability fact after validating the original package', async () => {
	const { root, packageJsonPath } = await fixture({ peer: '10.0.1', dev: '10.0.1' })
	let uses = true
	const hook = createPluginDependencyMetadataHook({
		packageJsonPath,
		log: () => {},
		collectPlugins: () => new Map(),
		collectWorkbenchTargets: async () => false,
		collectTinybaseConsumers: () => uses,
		workbenchArtifacts: false,
	})
	const output = { outDir: join(root, 'plugin/dist') } as Parameters<typeof hook>[0]
	await hook(output, new AbortController().signal)
	expect(JSON.parse(await readFile(packageJsonPath, 'utf8')).pluxel.tinybase).toBe('10.0.1')
	uses = false
	await hook(output, new AbortController().signal)
	expect(JSON.parse(await readFile(packageJsonPath, 'utf8')).pluxel.tinybase).toBeUndefined()
})
