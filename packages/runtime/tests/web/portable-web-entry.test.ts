import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
	parseRuntimeMeta,
	type PluginDependencyGraphEdge,
	type PluginDependencyGraphSnapshot,
	type RuntimeManagementClient,
	type RuntimeMeta,
} from '../../src/web'

describe('@pluxel/runtime/web framework boundary', () => {
	it('loads without React, Mantine, fetch, or a transport constructor', async () => {
		vi.resetModules()
		vi.doMock('react', () => {
			throw new Error('The framework-neutral web entry evaluated React')
		})
		vi.doMock('@mantine/core', () => {
			throw new Error('The framework-neutral web entry evaluated Mantine')
		})

		const web = await import('../../src/web')
		expect(web.createRuntimeManagementClient).toEqual(expect.any(Function))
		expect(web).not.toHaveProperty('discoverRuntime')
		expect(web).not.toHaveProperty('createRuntimeTransportClient')
		expect(web).not.toHaveProperty('createAdminAccessAwareFetch')
	})

	it('exports the closed dependency graph DTO through the injected client', () => {
		expectTypeOf<ReturnType<RuntimeManagementClient['dependencies']['graph']>>().toEqualTypeOf<
			Promise<PluginDependencyGraphSnapshot>
		>()
		type OptionalUnresolved = Extract<
			PluginDependencyGraphEdge,
			{ mode: 'optional'; resolution: { state: 'unresolved' } }
		>
		type EffectiveUnresolved = Extract<
			PluginDependencyGraphEdge,
			{ resolution: { state: 'unresolved' }; effective: true }
		>
		expectTypeOf<OptionalUnresolved>().toEqualTypeOf<never>()
		expectTypeOf<EffectiveUnresolved>().toEqualTypeOf<never>()
	})

	it('keeps fixed session transport out of runtime metadata', () => {
		type WorkbenchDetail = Extract<keyof RuntimeMeta['workbench'], 'revision' | 'renderers'>
		type Transport = Extract<keyof RuntimeMeta, 'transport'>
		expectTypeOf<WorkbenchDetail>().toEqualTypeOf<never>()
		expectTypeOf<Transport>().toEqualTypeOf<never>()

		const metadata = {
			service: 'pluxel-runtime',
			ready: true,
			protocol: {
				name: 'pluxel.management',
				major: 3,
				capabilities: ['plugin-catalog'],
			},
			application: { product: null },
			platform: {
				runtime: { name: 'node', version: '24.0.0' },
				deployment: { provider: null, ci: false },
				mode: 'test',
				platform: 'linux',
			},
			workbench: { enabled: true },
		}
		expect(parseRuntimeMeta(metadata)).toEqual(metadata)
		expect(() => parseRuntimeMeta({ ...metadata, transport: {} })).toThrow(
			'runtime metadata contains unsupported field transport',
		)
	})

	it('accepts and freezes the optional browser-safe platform snapshot', () => {
		const parsed = parseRuntimeMeta({
			service: 'pluxel-runtime',
			ready: true,
			protocol: {
				name: 'pluxel.management',
				major: 3,
				capabilities: ['plugin-catalog'],
			},
			application: { product: null },
			platform: {
				runtime: { name: 'workerd', version: null },
				deployment: { provider: 'cloudflare_workers', ci: false },
				mode: 'production',
				platform: null,
			},
			workbench: { enabled: true },
		})
		expect(parsed.platform).toMatchObject({
			runtime: { name: 'workerd' },
			deployment: { provider: 'cloudflare_workers' },
		})
		expect(Object.isFrozen(parsed.platform)).toBe(true)
		expect(Object.isFrozen(parsed.platform?.runtime)).toBe(true)
	})
})
