import { describe, expect, it } from 'vitest'

import * as runtimeDynamic from '@pluxel/runtime-dynamic'
import { createDynamicDevRuntime, defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { dynamicRuntimeVitePlugin } from '@pluxel/runtime-dynamic/vite'

describe('@pluxel/runtime-dynamic/vite', () => {
	it('exposes only the explicit dynamic dev/HMR direct launcher', () => {
		expect(runtimeDynamic.createDynamicDevRuntime).toBe(createDynamicDevRuntime)
		expect('createDynamicRuntime' in runtimeDynamic).toBe(false)
	})

	it('marks dynamic runtime config without exposing nested Vite or HMR config', () => {
		const config = defineDynamicRuntimeConfig({
			root: '/repo',
			configPath: 'pluxel.loader.hmr.jsonc',
			profile: 'dev',
			runtimeState: { mode: 'memory', snapshot: { enabled: ['DemoPlugin'] } },
		})

		expect(Object.keys(config)).toEqual(['root', 'configPath', 'profile', 'runtimeState'])
		expect(config.runtimeState?.snapshot?.enabled).toEqual(['DemoPlugin'])
		expect(() =>
			defineDynamicRuntimeConfig({
				root: '/repo',
				vite: {},
			} as never),
		).toThrow(/nested "vite" field/i)
		expect(() =>
			defineDynamicRuntimeConfig({
				root: '/repo',
				hmr: {},
			} as never),
		).toThrow(/must not include an "hmr" field/i)
		expect(() =>
			defineDynamicRuntimeConfig({
				root: '/repo',
				http: { controlPlane: { rpc: true } },
			} as never),
		).toThrow(/http must not include "controlPlane"/i)
	})

	it('keeps runtime context config at the same top level as static route config', () => {
		const config = defineDynamicRuntimeConfig({
			root: '/repo',
			configPath: 'pluxel.loader.hmr.jsonc',
			profile: 'dev',
			runtimeState: { snapshot: { enabled: ['DemoPlugin'] } },
			webManagement: { enabled: true, access: { exposure: 'private' } },
			logger: { preset: 'hmr' },
		})

		expect(config.runtimeState?.snapshot?.enabled).toEqual(['DemoPlugin'])
		expect(config.webManagement).toEqual({
			enabled: true,
			access: { exposure: 'private' },
		})
		expect(config.context).toBeUndefined()
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
