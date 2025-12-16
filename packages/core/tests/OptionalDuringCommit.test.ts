import { describe, expect, it } from 'bun:test'

import { BasePlugin, Plugin, withPluginTestHost } from '@pluxel/core/test'

describe('optional() during commit()', () => {
	it('does not warn "not registered" for plugins in the active draft container', async () => {
		await withPluginTestHost(async (host) => {
			const ctx = host.ctx as any
			const warns: unknown[][] = []
			const infos: unknown[][] = []
			const originalWarn = ctx.logger.warn
			const originalInfo = ctx.logger.info
			ctx.logger.warn = ((...args: unknown[]) => warns.push(args)) as any
			ctx.logger.info = ((...args: unknown[]) => infos.push(args)) as any

			const events: string[] = []

			@Plugin({ name: 'Provider' })
			class Provider extends BasePlugin {
				override init(): void {
					events.push('provider:init')
				}
			}

			@Plugin({ name: 'Consumer' })
			class Consumer extends BasePlugin {
				override init(): void {
					events.push('consumer:init')
					// Provider is registered in the same commit, but may not be running yet.
					this.ctx.registry.optional(Provider, (dep) => {
						events.push(dep ? 'after:hit' : 'after:miss')
					})
				}
			}

			host.registerAll(Provider, Consumer)
			await host.commitStrict()
			await Promise.resolve()

			// The warning should NOT claim "not registered" because Provider is in the draft container.
			expect(
				warns.some((args) => String(args?.[1] ?? '').includes('未在容器中')),
			).toBe(false)

			// Handler should eventually observe Provider as running after the commit completes.
			expect(events).toContain('consumer:init')
			expect(events).toContain('provider:init')
			expect(events).toContain('after:hit')

			ctx.logger.warn = originalWarn
			ctx.logger.info = originalInfo
		})
	})
})
