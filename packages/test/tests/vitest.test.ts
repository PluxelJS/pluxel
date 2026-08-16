import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { ViteUserConfig } from 'vitest/config'
import { buildPluxelResolveConditions, definePluxelVitestConfig } from '../src/vitest'

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
		const config = definePluxelVitestConfig({
			root: 'packages/test',
			test: { name: 'sync-config' },
		}) as ViteUserConfig

		expect(rolldownMocks.lintGuardPlugin).toHaveBeenLastCalledWith({
			cwd: resolve(process.cwd(), 'packages/test'),
		})
		expect(config.plugins?.[0]).toMatchObject({
			name: expect.stringMatching(/^database-source-/),
			options: { root: resolve(process.cwd(), 'packages/test') },
		})
		expect(config.plugins?.[1]).toMatchObject({
			name: expect.stringMatching(/^plugin-semantics-/),
			options: { root: resolve(process.cwd(), 'packages/test') },
		})
		expect(config.plugins?.[2]).toMatchObject({
			options: {
				cwd: resolve(process.cwd(), 'packages/test'),
			},
		})
		expect(config.test?.setupFiles).toHaveLength(1)
		expect(config.test?.setupFiles?.[0]).toMatch(
			/packages\/test\/(?:src|dist)\/setup\.(?:ts|mjs|cjs)$/,
		)
		expect(config).not.toHaveProperty('then')
		expect(config.test?.name).toBe('sync-config')
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

	it('keeps node conditions deterministic', () => {
		expect(buildPluxelResolveConditions('test')).toEqual([
			'@pluxel/hmr',
			'development',
			'@pluxel/source',
			'node',
			'import',
			'production',
			'default',
			'test',
		])
	})

	it('includes source files directly under configured toolchain roots', () => {
		definePluxelVitestConfig({}, { include: ['src/**/*.ts'] })

		expect(rolldownMocks.configSourcePlugin).toHaveBeenLastCalledWith({
			include: ['**/src/**/*.ts', '**/src/*.ts'],
			exclude: ['**/node_modules/**', '**/*.d.ts'],
		})
	})
})
