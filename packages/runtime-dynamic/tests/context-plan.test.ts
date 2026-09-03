import type { Context } from '@pluxel/core'
import { createRuntimeInternalTestHost } from '@pluxel/runtime/internal/test'
import { describe, expect, it } from 'vitest'
import {
	createDynamicRouteContextCapabilities,
	requireLoaderService,
	requireScanService,
} from '../src/context-plan'

type DynamicRouteContextKeys = Extract<'loader' | 'scanService', keyof Context>
const contextTypeHasNoDynamicRouteKeys: DynamicRouteContextKeys extends never ? true : false = true

describe('dynamic route Context capabilities', () => {
	it('keeps route services out of the public Context contract', async () => {
		const host = createRuntimeInternalTestHost({ workbench: false })
		try {
			expect(contextTypeHasNoDynamicRouteKeys).toBe(true)
			expect('loader' in host.ctx).toBe(false)
			expect('scanService' in host.ctx).toBe(false)
			expect(() => requireLoaderService(host.ctx)).toThrow(
				/does not install runtime-dynamic\.loader/,
			)
			expect(() => requireScanService(host.ctx)).toThrow(/does not install runtime-dynamic\.scan/)
		} finally {
			await host.dispose()
		}
	})

	it('resolves installed services through stable internal descriptors', async () => {
		const workspaceRoot = '/virtual/pluxel-workspace'
		const host = createRuntimeInternalTestHost(
			{ workbench: false },
			{
				routeContextCapabilities: createDynamicRouteContextCapabilities({ workspaceRoot }),
			},
		)
		try {
			const loader = requireLoaderService(host.ctx)
			const scan = requireScanService(host.ctx)
			expect(requireLoaderService(host.ctx)).toBe(loader)
			expect(requireScanService(host.ctx)).toBe(scan)
			expect(scan.defaultRoots).toEqual([workspaceRoot])
			expect('loader' in host.ctx).toBe(false)
			expect('scanService' in host.ctx).toBe(false)
		} finally {
			await host.dispose()
		}
	})
})
