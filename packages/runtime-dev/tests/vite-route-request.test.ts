import { describe, expect, it, vi } from 'vitest'
import { shouldHandleRuntimeViteRequest } from '../src/internal/vite-route-request'

function shouldHandle(
	url: string,
	overrides: Partial<Parameters<typeof shouldHandleRuntimeViteRequest>[0]> = {},
) {
	return shouldHandleRuntimeViteRequest({
		url,
		method: 'GET',
		accept: 'text/html',
		workbenchEnabled: true,
		matchesMountedRoute: () => false,
		matchesWorkbenchUiRoute: () => true,
		...overrides,
	})
}

describe('Runtime Vite request arbitration', () => {
	it('hands dotted Workbench document routes to the Runtime', () => {
		expect(
			shouldHandle(
				'/plugin-graph/node/v1/source/Consumer/app/3/src/demo/PluginOptionalIntegrationDemo.ts',
			),
		).toBe(true)
		expect(shouldHandle('/plugin-graph/edge/provider.js/requires/consumer.css')).toBe(true)
	})

	it('leaves asset subrequests and Vite internal paths with Vite', () => {
		expect(shouldHandle('/plugin-graph/node.ts', { accept: 'text/css,*/*;q=0.1' })).toBe(false)
		expect(shouldHandle('/@vite/client')).toBe(false)
		expect(shouldHandle('/node_modules/example/index.js')).toBe(false)
	})

	it('preserves mounted Runtime and disabled Workbench ownership', () => {
		const matchesMountedRoute = vi.fn(() => true)
		expect(
			shouldHandle('/business/file.ts', {
				accept: '*/*',
				workbenchEnabled: false,
				matchesMountedRoute,
			}),
		).toBe(true)
		expect(matchesMountedRoute).toHaveBeenCalledWith('/business/file.ts')
		expect(shouldHandle('/plugin-graph/node.ts', { workbenchEnabled: false })).toBe(false)
		expect(shouldHandle('/plugin-graph/node.ts', { method: 'POST' })).toBe(false)
		expect(
			shouldHandle('/__pluxel/workbench/assets/client.js', {
				accept: '*/*',
				workbenchEnabled: false,
			}),
		).toBe(true)
		expect(shouldHandle('/__pluxel?inspect=1', { workbenchEnabled: false })).toBe(true)
	})
})
