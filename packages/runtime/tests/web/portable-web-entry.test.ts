import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
	parseRuntimeMetaV1,
	type PluginDependencyGraphEdge,
	type PluginDependencyGraphSnapshot,
	type RuntimeManagementClient,
	type RuntimeMetaV1,
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
		type WorkbenchDetail = Extract<keyof RuntimeMetaV1['workbench'], 'revision' | 'renderers'>
		type Transport = Extract<keyof RuntimeMetaV1, 'transport'>
		expectTypeOf<WorkbenchDetail>().toEqualTypeOf<never>()
		expectTypeOf<Transport>().toEqualTypeOf<never>()

		const metadata = {
			service: 'pluxel-runtime',
			ready: true,
			protocol: {
				name: 'pluxel.management',
				major: 1,
				capabilities: ['plugins.list'],
			},
			application: { product: null },
			workbench: { enabled: true },
		}
		expect(parseRuntimeMetaV1(metadata)).toEqual(metadata)
		expect(() => parseRuntimeMetaV1({ ...metadata, transport: {} })).toThrow(
			'runtime metadata contains unsupported field transport',
		)
	})
})
