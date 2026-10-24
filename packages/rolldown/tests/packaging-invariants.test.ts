import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { buildPluxelFrontendResolveConditions } from '../src/workspace/vite.ts'

type CoreContextPublicEntry = Readonly<{
	createCoreContextHost(
		options: Readonly<{ name: string; capabilities: readonly unknown[] }>,
	): Readonly<{
		createRoot(): unknown
	}>
}>

type CoreContextInternalEntry = Readonly<{
	defineContextCapability(description: string): unknown
	installRootCapability(capability: unknown, options: Readonly<{ create(): unknown }>): unknown
	resolveContextCapability(ctx: unknown, capability: unknown): unknown
}>

function resolveCoreContextCapability(
	publicEntry: CoreContextPublicEntry,
	internalEntry: CoreContextInternalEntry,
): unknown {
	const capability = internalEntry.defineContextCapability('packaging.shared-context-kernel')
	const installation = internalEntry.installRootCapability(capability, {
		create: () => 'shared',
	})
	const host = publicEntry.createCoreContextHost({
		name: 'packaging-shared-kernel',
		capabilities: [installation],
	})
	return internalEntry.resolveContextCapability(host.createRoot(), capability)
}

describe('built package entry behavior', () => {
	it('shares the Context kernel between Core public and internal ESM entries', async () => {
		const publicEntry = await import(new URL('../../core/dist/host.mjs', import.meta.url).href)
		const internalEntry = await import(
			new URL('../../core/dist/internal.mjs', import.meta.url).href
		)
		expect(resolveCoreContextCapability(publicEntry, internalEntry)).toBe('shared')
	})

	it('shares the Context kernel between Core public and internal CommonJS entries', () => {
		const require = createRequire(import.meta.url)
		expect(
			resolveCoreContextCapability(
				require('../../core/dist/host.cjs'),
				require('../../core/dist/internal.cjs'),
			),
		).toBe('shared')
	})

	it('prefers community development entries before framework source entries in frontend graphs', () => {
		expect(buildPluxelFrontendResolveConditions('development').slice(0, 2)).toEqual([
			'development',
			'@pluxel/source',
		])
	})
})
