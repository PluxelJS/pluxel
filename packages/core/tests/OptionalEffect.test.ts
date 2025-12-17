import { describe, expect, it } from 'bun:test'

import { BasePlugin, Plugin, withTestHost } from '@pluxel/core/test'

describe('registry.optional()', () => {
	it('runs effect on availability changes and cleans up previous effects', async () => {
		await withTestHost(async (host) => {
			const events: string[] = []

			@Plugin({ name: 'EffectProvider' })
			class EffectProvider extends BasePlugin {
				override init(): void {
					events.push('provider:init')
				}
			}

			host.optional(
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

			host.register(EffectProvider)
			await host.commitStrict()

			expect(events).toEqual(['effect:miss:unregistered', 'provider:init', 'effect:hit'])

			host.unregister(EffectProvider)
			await host.commitStrict()

			expect(events).toEqual([
				'effect:miss:unregistered',
				'provider:init',
				'effect:hit',
				'cleanup:hit',
				'effect:miss:unregistered',
			])
		})
	})

	it('marks DI/resolve failures as failed in optional logs', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'ResolveFail' })
			class ResolveFail extends BasePlugin {
				constructor() {
					super()
					throw new Error('ctor boom')
				}
			}

			host.register(ResolveFail)
			await host.commit()

			let state: string | undefined
			host.optional(ResolveFail, (_dep, info) => {
				state = info.availability.state
			})
			await Promise.resolve()
			expect(state).toBe('failed')
		})
	})
})
