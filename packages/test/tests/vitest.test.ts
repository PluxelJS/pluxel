import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

const rolldownMocks = vi.hoisted(() => {
	const lintGuardPlugin = vi.fn((options?: unknown) => ({
		name: `lint-guard-${lintGuardPlugin.mock.calls.length}`,
		options,
	}))
	const configSourcePlugin = vi.fn((options?: unknown) => ({
		name: `config-source-${configSourcePlugin.mock.calls.length}`,
		options,
	}))
	const databaseSourceVitePlugin = vi.fn((options?: unknown) => ({
		name: `database-source-${databaseSourceVitePlugin.mock.calls.length}`,
		options,
	}))
	const createPluginSemanticsPlugin = vi.fn((options?: unknown) => ({
		plugin: {
			name: `plugin-semantics-${createPluginSemanticsPlugin.mock.calls.length}`,
			options,
		},
	}))

	return {
		lintGuardPlugin,
		configSourcePlugin,
		createPluginSemanticsPlugin,
		databaseSourceVitePlugin,
	}
})

vi.mock('@pluxel/rolldown/plugins', () => rolldownMocks)
vi.mock('@pluxel/rolldown/vite', () => ({
	databaseSourceVitePlugin: rolldownMocks.databaseSourceVitePlugin,
}))

afterEach(() => {
	vi.clearAllMocks()
})

describe('@pluxel/test/vitest', () => {
	it('composes the pipeline while preserving user options and fixing source identity', () => {
		const prePlugin = { name: 'author-pre' }
		const postPlugin = { name: 'author-post' }
		const config = definePluxelVitestConfig({
			root: 'packages/test',
			plugins: [postPlugin],
			resolve: { conditions: ['browser'], alias: { example: '/example' } },
			ssr: { resolve: { externalConditions: ['module'] } },
			test: { name: 'consumer', passWithNoTests: false, setupFiles: ['./setup.ts'] },
			pluxel: { prePlugins: [prePlugin] },
		})

		expect(config.plugins).toEqual([
			prePlugin,
			expect.objectContaining({ name: expect.stringMatching(/^database-source-/) }),
			expect.objectContaining({ name: expect.stringMatching(/^plugin-semantics-/) }),
			expect.objectContaining({ name: expect.stringMatching(/^lint-guard-/) }),
			expect.objectContaining({ name: expect.stringMatching(/^config-source-/) }),
			postPlugin,
		])
		const root = resolve(process.cwd(), 'packages/test')
		expect(rolldownMocks.databaseSourceVitePlugin).toHaveBeenLastCalledWith({ root })
		expect(rolldownMocks.lintGuardPlugin).toHaveBeenLastCalledWith({ cwd: root })
		expect(config.test).toMatchObject({
			name: 'consumer',
			passWithNoTests: false,
			setupFiles: ['./setup.ts'],
			server: { deps: { inline: ['@pluxel/services'] } },
		})
		expect(config).not.toHaveProperty('pluxel')
		expect(config.resolve?.alias).toEqual({ example: '/example' })
		for (const resolution of [config.resolve, config.ssr?.resolve]) {
			expect(resolution?.conditions?.slice(0, 3)).toEqual([
				'@pluxel/hmr',
				'development',
				'@pluxel/source',
			])
			expect(resolution?.conditions).not.toContain('browser')
			expect(resolution?.externalConditions).toEqual(['node', 'default'])
		}
		expect(config.ssr?.noExternal).toEqual(['@pluxel/services'])
	})

	it('preserves native CommonJS require conditions for dual-format external dependencies', async () => {
		const config = definePluxelVitestConfig()
		const root = await mkdtemp(join(tmpdir(), 'pluxel-test-require-conditions-'))
		try {
			const dependency = join(root, 'node_modules', 'dual-format')
			await mkdir(dependency, { recursive: true })
			await Promise.all([
				writeFile(
					join(dependency, 'package.json'),
					JSON.stringify({
						name: 'dual-format',
						exports: { '.': { import: './import.mjs', require: './require.cjs' } },
					}),
				),
				writeFile(join(dependency, 'import.mjs'), 'export default class Pool {}'),
				writeFile(
					join(dependency, 'require.cjs'),
					"module.exports = class Pool { mode = 'require' }",
				),
				writeFile(
					join(root, 'consumer.cjs'),
					"const Pool = require('dual-format'); class BoundPool extends Pool {}; process.stdout.write(new BoundPool().mode)",
				),
			])
			// Vitest propagates SSR conditions into worker Node flags. A real Node
			// subprocess catches accidental ESM selection inside a CJS dependency.
			const conditions = config.ssr?.resolve?.conditions ?? []
			const result = spawnSync(
				process.execPath,
				[...conditions.flatMap((condition) => ['--conditions', condition]), 'consumer.cjs'],
				{ cwd: root, encoding: 'utf8', timeout: 10_000 },
			)
			expect(result.stderr).toBe('')
			expect(result.status).toBe(0)
			expect(result.stdout).toBe('require')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})

	it.each([
		[
			undefined,
			['src', 'tests'].flatMap((dir) =>
				['ts', 'tsx'].flatMap((ext) => [`**/${dir}/**/*.${ext}`, `**/${dir}/*.${ext}`]),
			),
		],
		['src/**/*.ts', ['**/src/**/*.ts', '**/src/*.ts']],
		[
			['src/**/*.ts', 'src/**/*.ts'],
			['**/src/**/*.ts', '**/src/*.ts'],
		],
	])(
		'normalizes source globs and keeps type probes out of both transforms (%j)',
		(include, expected) => {
			definePluxelVitestConfig({ pluxel: { include } })
			const options = {
				include: expected,
				exclude: [
					'**/node_modules/**',
					'**/*.d.ts',
					...['ts', 'tsx', 'mts', 'cts'].map((ext) => `**/*.typecheck.${ext}`),
				],
			}
			expect(rolldownMocks.configSourcePlugin).toHaveBeenLastCalledWith(options)
			expect(rolldownMocks.createPluginSemanticsPlugin).toHaveBeenLastCalledWith({
				root: process.cwd(),
				...options,
			})
		},
	)
})
