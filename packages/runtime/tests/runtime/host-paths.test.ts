import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'

import { resolveProfiledPath, resolveRuntimeStoragePaths } from '../../src/runtime/paths'

describe('runtime host path policy', () => {
	it('uses runtime-owned defaults for managed hosts', () => {
		const root = '/workspace/app'
		const paths = resolveRuntimeStoragePaths(root)

		expect(paths.configFile).toBe(resolve(root, 'data/runtime/config.json'))
		expect(paths.pluginDataDir).toBe(resolve(root, 'data/plugin-data'))
		expect(paths.packageStateFile).toBe(resolve(root, 'data/runtime/package-state.json'))
		expect(paths.logsDir).toBe(resolve(root, 'logs'))
		expect(paths.logFile).toBe(resolve(root, 'logs/runtime.log'))
	})

	it('expands profiled config paths without leaking dev-route semantics into runtime helpers', () => {
		const resolved = resolveProfiledPath('/workspace/app/.pluxel/runtime/config.json', 'dev')
		expect(resolved.path).toBe('/workspace/app/.pluxel/runtime/config.dev.json')
		expect(resolved.fallbackPath).toBe('/workspace/app/.pluxel/runtime/config.json')
	})

	it('supports explicit {profile} layout tokens for host-owned storage policies', () => {
		const resolved = resolveProfiledPath(
			'/workspace/app/.pluxel/runtime/{profile}/config.json',
			'prod',
		)
		expect(resolved.path).toBe('/workspace/app/.pluxel/runtime/prod/config.json')
		expect(resolved.fallbackPath).toBeUndefined()
	})
})
