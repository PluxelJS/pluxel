import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
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
			expect(resolution?.externalConditions).toEqual(['node', 'import', 'default'])
		}
		expect(config.ssr?.noExternal).toEqual(['@pluxel/services'])
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
