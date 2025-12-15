import { describe, expect, it } from 'bun:test'

import { BasePlugin, Context, Plugin } from './context'

describe('registry.optional()', () => {
	it('runs effect on availability changes and cleans up previous effects', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry

		const events: string[] = []

		@Plugin({ name: 'EffectProvider' })
		class EffectProvider extends BasePlugin {
			override init(): void {
				events.push('provider:init')
			}
		}

		ctx.registry.optional(
			EffectProvider,
			(dep, info) => {
				events.push(dep ? 'effect:hit' : `effect:miss:${info.availability.state}`)
				if (dep) return () => void events.push('cleanup:hit')
			},
			{ runOnInit: true },
		)

		// optional() runs through a microtask chain to serialize cleanups.
		await Promise.resolve()
		expect(events).toEqual(['effect:miss:unregistered'])

		pluginRegistry.registerPlugin(EffectProvider)
		await ctx.registry.commit()

		expect(events).toEqual(['effect:miss:unregistered', 'provider:init', 'effect:hit'])

		pluginRegistry.unregisterPlugin(EffectProvider)
		await ctx.registry.commit()

		expect(events).toEqual([
			'effect:miss:unregistered',
			'provider:init',
			'effect:hit',
			'cleanup:hit',
			'effect:miss:unregistered',
		])
	})

	it('marks DI/resolve failures as failed in optional logs', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry

		@Plugin({ name: 'ResolveFail' })
		class ResolveFail extends BasePlugin {
			constructor() {
				super()
				throw new Error('ctor boom')
			}
		}

		pluginRegistry.registerPlugin(ResolveFail)
		await ctx.registry.commit()

		let state: string | undefined
		ctx.registry.optional(ResolveFail, (_dep, info) => {
			state = info.availability.state
		})
		await Promise.resolve()
		expect(state).toBe('failed')
	})
})
