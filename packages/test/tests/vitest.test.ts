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

	return { lintGuardPlugin, configSourcePlugin }
})

vi.mock('@pluxel/build/rolldown', () => rolldownMocks)

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
		expect(config.ssr?.resolve?.conditions).toEqual(
			expect.arrayContaining(['@pluxel/source', '@pluxel/hmr']),
		)
	})

	it('keeps node conditions deterministic', () => {
		expect(buildPluxelResolveConditions('test')).toEqual([
			'@pluxel/source',
			'@pluxel/hmr',
			'node',
			'import',
			'module',
			'development',
			'production',
			'default',
			'browser',
			'test',
		])
	})
})
