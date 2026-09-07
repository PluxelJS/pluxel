import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { ViteUserConfig } from 'vitest/config'
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
	it('builds the fixed Pluxel test pipeline', () => {
		const prePlugin = { name: 'author-pre' }
		const config = definePluxelVitestConfig({
			root: 'packages/test',
			test: {
				name: 'sync-config',
				passWithNoTests: false,
				setupFiles: ['./tests/consumer-setup.ts'],
			},
			pluxel: { prePlugins: [prePlugin] },
		}) as ViteUserConfig

		expect(rolldownMocks.lintGuardPlugin).toHaveBeenLastCalledWith({
			cwd: resolve(process.cwd(), 'packages/test'),
		})
		expect(config.plugins?.[0]).toBe(prePlugin)
		expect(config.plugins?.[1]).toMatchObject({
			name: expect.stringMatching(/^database-source-/),
			options: { root: resolve(process.cwd(), 'packages/test') },
		})
		expect(config.plugins?.[2]).toMatchObject({
			name: expect.stringMatching(/^plugin-semantics-/),
			options: {
				root: resolve(process.cwd(), 'packages/test'),
				include: [
					'**/src/**/*.ts',
					'**/src/*.ts',
					'**/src/**/*.tsx',
					'**/src/*.tsx',
					'**/tests/**/*.ts',
					'**/tests/*.ts',
					'**/tests/**/*.tsx',
					'**/tests/*.tsx',
				],
				exclude: [
					'**/node_modules/**',
					'**/*.d.ts',
					'**/*.typecheck.ts',
					'**/*.typecheck.tsx',
					'**/*.typecheck.mts',
					'**/*.typecheck.cts',
				],
			},
		})
		expect(config.plugins?.[3]).toMatchObject({
			options: {
				cwd: resolve(process.cwd(), 'packages/test'),
			},
		})
		expect(config.test?.setupFiles).toEqual(['./tests/consumer-setup.ts'])
		expect(config).not.toHaveProperty('then')
		expect(config).not.toHaveProperty('pluxel')
		expect(config.test?.name).toBe('sync-config')
		expect(config.test?.passWithNoTests).toBe(false)
		expect(config.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', '@pluxel/hmr']),
		)
		expect(config.resolve?.externalConditions).toEqual(['node', 'import', 'default'])
		expect(config.ssr?.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', '@pluxel/hmr']),
		)
		expect(config.ssr?.resolve?.externalConditions).toEqual(['node', 'import', 'default'])
		expect(config.ssr?.noExternal).toEqual(['@pluxel/runtime'])
		expect(config.test?.server?.deps?.inline).toEqual(['@pluxel/runtime'])
	})

	it('uses the pluxel namespace for source toolchain roots', () => {
		definePluxelVitestConfig({
			pluxel: { include: ['src/**/*.ts'] },
		})

		expect(rolldownMocks.configSourcePlugin).toHaveBeenLastCalledWith({
			include: ['**/src/**/*.ts', '**/src/*.ts'],
			exclude: [
				'**/node_modules/**',
				'**/*.d.ts',
				'**/*.typecheck.ts',
				'**/*.typecheck.tsx',
				'**/*.typecheck.mts',
				'**/*.typecheck.cts',
			],
		})
	})

	it('uses package-local source and test globs by default', () => {
		definePluxelVitestConfig({})

		expect(rolldownMocks.configSourcePlugin).toHaveBeenLastCalledWith({
			include: [
				'**/src/**/*.ts',
				'**/src/*.ts',
				'**/src/**/*.tsx',
				'**/src/*.tsx',
				'**/tests/**/*.ts',
				'**/tests/*.ts',
				'**/tests/**/*.tsx',
				'**/tests/*.tsx',
			],
			exclude: [
				'**/node_modules/**',
				'**/*.d.ts',
				'**/*.typecheck.ts',
				'**/*.typecheck.tsx',
				'**/*.typecheck.mts',
				'**/*.typecheck.cts',
			],
		})
	})
})
