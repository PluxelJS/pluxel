import { createMemoryPersistenceBackend } from '@pluxel/runtime'
import { createRuntimeHost } from '@pluxel/runtime/test'
import { SuperJSON } from 'superjson'
import { describe, expect, it } from 'vitest'

describe('RuntimeState v2 persistence', () => {
	it('migrates v1 state without carrying fixed-catalog history forward', async () => {
		const backend = createMemoryPersistenceBackend()
		const namespace = backend.namespace('runtime-state')
		await namespace.put(
			'state.json',
			SuperJSON.stringify({
				version: 1,
				enabled: ['Provider', 'Consumer'],
				forks: { Provider: ['worker'] },
				baseProviders: { ProviderBase: 'Provider' },
				dependencyOverrides: { Consumer: { 0: 'Provider' } },
				builtinsKnown: { Provider: 1 },
				optionalKnown: { OptionalProvider: 1 },
			}),
		)

		const host = createRuntimeHost({
			workbench: false,
			persistence: { mode: 'custom', backend },
			runtimeState: { mode: 'file' },
		})
		try {
			await host.ctx.runtimeState.ready
			const snapshot = host.ctx.runtimeState.snapshot()
			expect(snapshot).toMatchObject({
				enabled: ['Provider', 'Consumer'],
				forks: { Provider: ['worker'] },
				baseProviders: { ProviderBase: 'Provider' },
				dependencyOverrides: { Consumer: { 0: 'Provider' } },
				optionalKnown: { OptionalProvider: 1 },
			})
			expect(snapshot).not.toHaveProperty('builtinsKnown')

			host.ctx.runtimeState.update((draft) => draft.enabled.add('Next'))
			await host.ctx.runtimeState.flush({ force: true })
			const persisted = SuperJSON.parse((await namespace.getText('state.json'))!) as Record<
				string,
				unknown
			>
			expect(persisted.version).toBe(2)
			expect(persisted.enabled).toEqual(['Provider', 'Consumer', 'Next'])
			expect(persisted).not.toHaveProperty('builtinsKnown')
		} finally {
			await host.dispose()
		}
	})

	it('rejects unknown persisted versions instead of interpreting future state', async () => {
		const backend = createMemoryPersistenceBackend()
		await backend
			.namespace('runtime-state')
			.put('state.json', SuperJSON.stringify({ version: 3, enabled: ['FuturePlugin'] }))
		const host = createRuntimeHost({
			workbench: false,
			persistence: { mode: 'custom', backend },
			runtimeState: { mode: 'file' },
		})
		try {
			await expect(host.ctx.runtimeState.ready).rejects.toThrow(
				/unsupported persisted state version: 3/i,
			)
		} finally {
			await host.dispose()
		}
	})
})
