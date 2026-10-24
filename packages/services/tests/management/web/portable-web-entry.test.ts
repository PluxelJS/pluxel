import { describe, expect, it, vi } from 'vitest'
import { parseRuntimeMeta, type RuntimeMeta } from '@pluxel/services/management/client'

describe('@pluxel/services/management/client framework boundary', () => {
	it('loads without React, Mantine, fetch, or a transport constructor', async () => {
		vi.resetModules()
		vi.doMock('react', () => {
			throw new Error('The framework-neutral web entry evaluated React')
		})
		vi.doMock('@mantine/core', () => {
			throw new Error('The framework-neutral web entry evaluated Mantine')
		})

		const web = await import('@pluxel/services/management/client')
		expect(web.createRuntimeManagementClient).toEqual(expect.any(Function))
	})

	it('keeps fixed session transport out of runtime metadata', () => {
		const metadata: RuntimeMeta = {
			service: 'pluxel-runtime',
			ready: true,
			protocol: {
				name: 'pluxel.management',
				major: 7,
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
		expect(() =>
			parseRuntimeMeta({ ...metadata, platform: { ...metadata.platform, mode: ['test'] } }),
		).toThrow(/platform.mode/)
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
				major: 7,
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
