import { describe, expect, test, vi } from 'vitest'
import { PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE } from '@pluxel/runtime/internal'
import { WorkspaceEntryResolver } from '../../src/hmr/engine/workspace-entry-resolver'
import type { HmrPathApi } from '../../src/hmr/engine/environment'

describe('WorkspaceEntryResolver', () => {
	test('orders plugin, community development, then framework source conditions', () => {
		expect(PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE.slice(0, 3)).toEqual([
			'@pluxel/hmr',
			'development',
			'@pluxel/source',
		])
	})

	test('passes loader HMR export conditions to workspace entry resolution', async () => {
		const calls: unknown[] = []
		const resolver = new WorkspaceEntryResolver(
			{
				resolveEntry: async (...args: unknown[]) => {
					calls.push(args)
					return {
						ok: true as const,
						dir: '/workspace/pkg',
						entry: '/workspace/pkg/src/index.ts',
						source: 'exports' as const,
						tried: [],
					}
				},
			},
			createPathApi(),
			PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE,
		)

		await expect(resolver.resolveBareWorkspaceEntry('pluxel-plugin-wretch')).resolves.toBe(
			'/clean/workspace/pkg/src/index.ts',
		)

		expect(calls).toEqual([
			[
				{ name: 'pluxel-plugin-wretch' },
				{
					workspaceOnly: true,
					scan: {
						conditions: [...PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE],
						preferHmrExports: true,
					},
				},
			],
		])
	})

	test('returns null for scan miss results', async () => {
		const resolver = new WorkspaceEntryResolver(
			{
				resolveEntry: async () => ({
					ok: false as const,
					dir: 'pluxel-plugin-missing',
					code: 'MISSING_PACKAGE' as const,
					message: 'Package not found.',
				}),
			},
			createPathApi(),
			PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE,
		)

		await expect(resolver.resolveBareWorkspaceEntry('pluxel-plugin-missing')).resolves.toBe(null)
	})

	test('does not swallow unexpected scan errors', async () => {
		const error = new Error('scan crashed')
		const resolver = new WorkspaceEntryResolver(
			{
				resolveEntry: vi.fn().mockRejectedValue(error),
			},
			createPathApi(),
			PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE,
		)

		await expect(resolver.resolveBareWorkspaceEntry('pluxel-plugin-broken')).rejects.toThrow(
			'scan crashed',
		)
	})
})

function createPathApi(): HmrPathApi {
	return {
		toClean: (id: string) => `/clean${id}`,
		toVite: (id: string) => id,
		pretty: (id: string) => id,
		variants: (id: string) => [id],
	}
}
