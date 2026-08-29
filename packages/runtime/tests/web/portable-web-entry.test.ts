import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
	parseRuntimeMetaV1,
	type OnAdminAccessBlocked,
	type PluginDependencyGraphEdge,
	type PluginDependencyGraphSnapshot,
	type RuntimeManagementClient,
	type RuntimeManagementClientOptions,
	type RuntimeMetaV1,
} from '../../src/web'

describe('@pluxel/runtime/web framework boundary', () => {
	it('loads the default web entry without evaluating React or Mantine', async () => {
		vi.resetModules()
		vi.doMock('react', () => {
			throw new Error('The framework-neutral web entry evaluated React')
		})
		vi.doMock('@mantine/core', () => {
			throw new Error('The framework-neutral web entry evaluated Mantine')
		})
		vi.doMock('@mantine/notifications', () => {
			throw new Error('The framework-neutral web entry evaluated Mantine notifications')
		})

		const web = await import('../../src/web')

		expect(web.discoverRuntime).toEqual(expect.any(Function))
		expect(web.createRuntimeManagementClient).toEqual(expect.any(Function))
		expect(web.rpcErrorMessage(new Error('denied'), 'fallback')).toBe('denied')
		expect(web.rpcErrorMessage(undefined, 'fallback')).toBe('fallback')
		expect(web).not.toHaveProperty('createRuntimeTransportClient')
		expect(web).not.toHaveProperty('RuntimeTransportClientProvider')
		expect(web).not.toHaveProperty('useRuntimeTransportClient')
	})

	it('keeps Level 1 options free of stream and session configuration', () => {
		type TransportOnlyOption = Extract<
			keyof RuntimeManagementClientOptions,
			'sse' | 'defaultNamespace'
		>
		expectTypeOf<TransportOnlyOption>().toEqualTypeOf<never>()
		expectTypeOf<RuntimeManagementClientOptions['adminAccess']>().toEqualTypeOf<
			false | { onBlocked?: OnAdminAccessBlocked } | undefined
		>()
	})

	it('exports the closed dependency graph DTO through the Level 1 client', () => {
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

	it('keeps Level 1 discovery free of View-host protocol facts', () => {
		type WorkbenchDetail = Extract<keyof RuntimeMetaV1['workbench'], 'revision' | 'renderers'>
		type WorkbenchTransport = Extract<keyof RuntimeMetaV1['transport'], 'workbenchEvents'>
		expectTypeOf<WorkbenchDetail>().toEqualTypeOf<never>()
		expectTypeOf<WorkbenchTransport>().toEqualTypeOf<never>()

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
			transport: { rpc: '/rpc' },
		}
		expect(parseRuntimeMetaV1(metadata)).toEqual(metadata)
		expect(() =>
			parseRuntimeMetaV1({
				...metadata,
				workbench: { enabled: true, renderers: [{ kind: 'react', abi: 1 }] },
			}),
		).toThrow('runtime metadata.workbench contains unsupported field renderers')
		expect(() =>
			parseRuntimeMetaV1({
				...metadata,
				transport: { rpc: '/rpc', workbenchEvents: '/sse' },
			}),
		).toThrow('runtime metadata.transport contains unsupported field workbenchEvents')
	})
})
