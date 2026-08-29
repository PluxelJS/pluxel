import { afterEach } from 'vitest'
import type { Context, PluginNodeAddress } from '@pluxel/core'
import type { RuntimeStateSnapshot } from '@pluxel/runtime/internal'
import { createRuntimeHost, type RuntimeHost } from '@pluxel/runtime/test'
import { createDynamicRouteContextCapabilities, requireLoaderService } from '../../src/context-plan'

export type HmrTestState = {
	autoStart?: readonly PluginNodeAddress[]
	runtimeState?: Partial<
		Pick<RuntimeStateSnapshot, 'forks' | 'providerDefaults' | 'dependencyOverrides'>
	>
}

export type HmrTestContext = {
	core: Context
	ctx: Context
	host: RuntimeHost
	dispose: () => Promise<void>
}

const active = new Set<HmrTestContext>()

afterEach(async () => {
	const pending = [...active]
	active.clear()
	await Promise.all(pending.map((fixture) => fixture.dispose()))
})

export function createHmrTestContext(state: HmrTestState = {}): HmrTestContext {
	const persisted = state.runtimeState ?? {}
	const host = createRuntimeHost(
		{
			workbench: false,
			persistence: { mode: 'memory' },
			configService: { mode: 'memory' },
			runtimeState: {
				mode: 'memory',
				snapshot: {
					autoStart: state.autoStart ?? [],
					forks: persisted.forks ?? [],
					providerDefaults: persisted.providerDefaults ?? [],
					dependencyOverrides: persisted.dependencyOverrides ?? [],
				},
			},
		},
		{ routeContextCapabilities: createDynamicRouteContextCapabilities() },
	)
	const ctx = host.ctx
	void requireLoaderService(ctx)
	const fixture: HmrTestContext = {
		core: ctx,
		ctx,
		host,
		dispose: async () => {
			if (!active.delete(fixture)) return
			await host.dispose()
		},
	}
	active.add(fixture)
	return fixture
}
