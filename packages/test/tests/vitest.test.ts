import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type { ViteUserConfig } from 'vitest/config'

const buildRolldownModule = '../../build/src/rolldown/index.ts'

async function loadVitestModule() {
	const lintGuardPlugin = vi.fn((options?: unknown) => ({
		name: `lint-guard-${lintGuardPlugin.mock.calls.length}`,
		options,
	}))
	const configSourcePlugin = vi.fn((options?: unknown) => ({
		name: `config-source-${configSourcePlugin.mock.calls.length}`,
		options,
	}))

	vi.doMock(buildRolldownModule, () => ({
		lintGuardPlugin,
		configSourcePlugin,
	}))

	const mod = await import('../src/vitest')
	return { ...mod, lintGuardPlugin, configSourcePlugin }
}

afterEach(() => {
	vi.resetModules()
	vi.doUnmock(buildRolldownModule)
})

describe('@pluxel/test/vitest', () => {
	it('binds lint guard to the merged project root', async () => {
		const { definePluxelVitestConfig, lintGuardPlugin } = await loadVitestModule()

		const config = (await definePluxelVitestConfig({
			root: 'packages/test',
		})) as ViteUserConfig

		expect(lintGuardPlugin).toHaveBeenLastCalledWith({
			cwd: resolve(process.cwd(), 'packages/test'),
		})
		expect(config.plugins?.[0]).toMatchObject({
			options: {
				cwd: resolve(process.cwd(), 'packages/test'),
			},
		})
		expect(config.test?.setupFiles).toHaveLength(1)
		expect(config.test?.setupFiles?.[0]).not.toBe('@pluxel/test/setup')
		expect(config.test?.setupFiles?.[0]).toMatch(/packages\/test\/(?:src|dist)\/setup\.(?:ts|mjs|cjs)$/)
	})
})
