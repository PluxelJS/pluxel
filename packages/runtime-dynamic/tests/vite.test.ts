import { describe, expect, it } from 'vitest'

import { defineDynamicRuntimeConfig, dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'

describe('@pluxel/runtime-dynamic/vite', () => {
	it('marks dynamic runtime config without exposing nested Vite config', () => {
		const config = defineDynamicRuntimeConfig({
			root: '/repo',
			configPath: 'pluxel.loader.hmr.jsonc',
			profile: 'dev',
		})

		expect(Object.keys(config)).toEqual(['root', 'configPath', 'profile'])
		expect(() =>
			defineDynamicRuntimeConfig({
				root: '/repo',
				vite: {},
			} as never),
		).toThrow(/nested "vite" field/i)
	})

	it('exposes a serve-only route plugin plus route-neutral source semantics', () => {
		const plugins = dynamicRuntimeVitePlugin({ config: './pluxel.dynamic.ts' }) as Array<{
			name?: string
			apply?: unknown
		}>

		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'pluxel:dynamic-runtime-source',
			'pluxel:dynamic-runtime',
		])
		expect(plugins[1]?.apply).toBe('serve')
	})
})
