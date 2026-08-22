import '../../src/register-services'
import { afterEach } from 'vitest'
import { createHost, type Host } from '@pluxel/test'
import type { Context, PluginDefinitionAddress, PluginNodeAddress } from '@pluxel/core'

export type HmrTestState = {
	enabled?: readonly PluginNodeAddress[]
	runtimeState?: {
		forks?: readonly {
			definition: PluginDefinitionAddress
			forkIds: readonly string[]
		}[]
		providerDefaults?: readonly {
			token: PluginDefinitionAddress
			provider: PluginNodeAddress
		}[]
		dependencyOverrides?: readonly {
			consumer: PluginNodeAddress
			parameterIndex: number
			provider: PluginNodeAddress
		}[]
	}
}

export type HmrTestContext = {
	core: Context
	ctx: Context
	host: Host
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
	const host = createHost({
		persistence: { mode: 'memory' },
		configService: { mode: 'memory' },
		runtimeState: {
			mode: 'memory',
			snapshot: {
				enabled: state.enabled ?? [],
				forks: persisted.forks ?? [],
				providerDefaults: persisted.providerDefaults ?? [],
				dependencyOverrides: persisted.dependencyOverrides ?? [],
			},
		},
		root: { loaderHmr: { normalizeId: (id: string) => id } },
	} as Context.Config)
	const ctx = host.ctx
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
