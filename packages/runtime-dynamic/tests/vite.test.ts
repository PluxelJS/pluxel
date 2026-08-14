import { describe, expect, it } from 'vitest'

import * as runtimeDynamic from '@pluxel/runtime-dynamic'
import { createDynamicDevRuntime, defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import * as runtimeDynamicHmr from '@pluxel/runtime-dynamic/hmr'
import * as runtimeDynamicVite from '@pluxel/runtime-dynamic/vite'

describe('@pluxel/runtime-dynamic/vite', () => {
	it('exposes only the explicit dynamic dev/HMR direct launcher', () => {
		expect(runtimeDynamic.createDynamicDevRuntime).toBe(createDynamicDevRuntime)
		expect(Object.keys(runtimeDynamic).sort()).toEqual([
			'createDynamicDevRuntime',
			'defineDynamicRuntimeConfig',
		])
	})

	it('keeps the HMR bridge separate from workspace diagnostics', () => {
		expect(Object.keys(runtimeDynamicHmr).sort()).toEqual([
			'bootPlannedLoaderHmrHost',
			'planLoaderHmrHost',
			'planLoaderHmrHostFromConfig',
		])
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
		expect(() => defineDynamicRuntimeConfig(null as never)).toThrow(/must be an object/i)
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
				deps: {},
			} as never),
		).toThrow(/must not include a "deps" tuning object/i)
		expect(() =>
			defineDynamicRuntimeConfig({
				root: '/repo',
				cjsExternal: ['legacy-commonjs'],
			} as never),
		).toThrow(/CommonJS and native host modules are detected automatically/i)
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
			workbench: {
				enabled: true,
				access: { exposure: 'private' },
				uiBasePath: '/__pluxel/workbench',
			},
			logging: false,
		})

		expect(config.runtimeState?.snapshot?.enabled).toEqual(['DemoPlugin'])
		expect(config.workbench).toEqual({
			enabled: true,
			access: { exposure: 'private' },
			uiBasePath: '/__pluxel/workbench',
		})
		expect(config.context).toBeUndefined()
	})

	it('accepts explicit mutable file sources without package-manager configuration', () => {
		class FixedPlugin {}
		const config = defineDynamicRuntimeConfig({
			root: '/repo',
			plugins: [FixedPlugin as never],
			sources: [
				{ kind: 'file', path: 'plugins/local.ts' },
				{ kind: 'directory', path: '.pluxel/plugins/entries', include: ['*.mjs'] },
			],
		})

		expect(config.sources).toHaveLength(2)
		expect(config.plugins).toEqual([FixedPlugin])
		expect(() =>
			defineDynamicRuntimeConfig({ root: '/repo', builtins: [FixedPlugin] } as never),
		).toThrow(/unsupported "builtins"/i)
		expect(() =>
			defineDynamicRuntimeConfig({ root: '/repo', builtinsFromDist: [] } as never),
		).toThrow(/unsupported "builtinsFromDist"/i)
		expect(() =>
			defineDynamicRuntimeConfig({
				sources: [{ kind: 'directory', path: '/plugins', include: ['nested/../../outside/*.mjs'] }],
			}),
		).toThrow(/must stay inside/i)
		expect(() =>
			defineDynamicRuntimeConfig({
				sources: [{ kind: 'directory', path: '/plugins' } as never],
			}),
		).toThrow(/include must be a non-empty array/i)
		expect(() =>
			defineDynamicRuntimeConfig({ root: '/repo', unknownPolicy: true } as never),
		).toThrow(/unsupported "unknownPolicy"/i)
		expect(() => defineDynamicRuntimeConfig({ root: '/repo', context: {} } as never)).toThrow(
			/unsupported "context"/i,
		)
	})

	it('exposes a serve-only route plugin plus route-neutral source semantics', () => {
		const plugins = runtimeDynamicVite.dynamicRuntimeVitePlugin({
			config: './pluxel.dynamic.ts',
		}) as Array<{
			name?: string
			apply?: unknown
			config?: (config: { cacheDir?: string }) =>
				| {
						resolve?: { dedupe?: string[] }
						cacheDir?: string
						[key: string]: unknown
				  }
				| undefined
		}>

		expect(plugins.map((plugin) => plugin.name)).toEqual([
			'pluxel:dynamic-singleton-bridge',
			'unplugin-preprocessor-directives',
			'pluxel:database-source',
			'pluxel:plugin-semantics',
			'pluxel-lint-guard',
			'pluxel-config-source',
			'pluxel:dynamic-runtime-source',
			'pluxel:host-modules',
			'pluxel:dynamic-runtime',
		])
		expect(plugins.at(-1)?.apply).toBe('serve')
		expect(plugins.at(-1)?.config?.({})).toMatchObject({
			cacheDir: '.pluxel/vite/dynamic-runtime-v2',
			optimizeDeps: {
				entries: [expect.stringContaining('/packages/workbench-app/src/client.tsx')],
				include: expect.arrayContaining(['@tabler/icons-react']),
			},
			server: { watch: { ignored: expect.arrayContaining([/(^|[/\\])target([/\\]|$)/]) } },
		})
		expect(plugins.at(-1)?.config?.({ cacheDir: '/custom/vite-cache' })).not.toHaveProperty(
			'cacheDir',
		)
		expect(plugins.at(-3)?.config?.({})?.resolve?.dedupe).toEqual(
			expect.arrayContaining(['react', 'react-dom', '@mantine/core', '@mantine/hooks']),
		)
		expect('defineDynamicRuntimeConfig' in runtimeDynamicVite).toBe(false)
	})

	it('uses built package exports and Workbench assets in distribution mode', () => {
		const plugins = runtimeDynamicVite.dynamicRuntimeVitePlugin({
			config: './pluxel.dynamic.ts',
			mode: 'distribution',
		}) as Array<{
			name?: string
			config?: (config: Record<string, unknown>) => Record<string, unknown> | undefined
		}>
		const source = plugins.find((plugin) => plugin.name === 'pluxel:dynamic-runtime-source')
		const route = plugins.at(-1)
		const sourceConfig = source?.config?.({}) as {
			resolve?: { conditions?: string[] }
			ssr?: { resolve?: { conditions?: string[] } }
		}
		const routeConfig = route?.config?.({}) as { optimizeDeps?: unknown }

		expect(sourceConfig.resolve?.conditions).toEqual(
			expect.arrayContaining(['node', 'import', 'default', 'production']),
		)
		expect(sourceConfig.resolve?.conditions).not.toEqual(
			expect.arrayContaining(['@pluxel/source', '@pluxel/hmr', 'development']),
		)
		expect(sourceConfig.ssr?.resolve?.conditions).toEqual(sourceConfig.resolve?.conditions)
		expect(routeConfig.optimizeDeps).toBeUndefined()
	})
})
