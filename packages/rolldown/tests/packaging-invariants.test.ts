import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

type CoreContextPublicEntry = Pick<typeof import('@pluxel/core/host'), 'createCoreContextHost'>
type CoreContextInternalEntry = Pick<
	typeof import('@pluxel/core/internal'),
	'installRootService' | 'resolveContextService'
>

function resolveCoreContextService(
	publicEntry: CoreContextPublicEntry,
	internalEntry: CoreContextInternalEntry,
): string {
	class SharedService {
		readonly value = 'shared'
	}
	const installation = internalEntry.installRootService(SharedService, {
		create: () => new SharedService(),
	})
	const host = publicEntry.createCoreContextHost({
		name: 'packaging-shared-kernel',
		services: [installation],
	})
	return internalEntry.resolveContextService(host.createRoot(), SharedService).value
}

describe('built package entry behavior', () => {
	it('shares the Context kernel between Core public and internal ESM entries', async () => {
		const publicEntry = await import(new URL('../../core/dist/host.mjs', import.meta.url).href)
		const internalEntry = await import(
			new URL('../../core/dist/internal.mjs', import.meta.url).href
		)
		expect(resolveCoreContextService(publicEntry, internalEntry)).toBe('shared')
	})

	it('shares the Context kernel between Core public and internal CommonJS entries', () => {
		const require = createRequire(import.meta.url)
		expect(
			resolveCoreContextService(
				require('../../core/dist/host.cjs'),
				require('../../core/dist/internal.cjs'),
			),
		).toBe('shared')
	})
})
