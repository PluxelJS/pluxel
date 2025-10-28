import { describe, expect, it } from 'bun:test'

import { BasePlugin, Context, Plugin } from './context'
import { PluginB } from './plugins'

function createDeferred() {
	let resolve!: () => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('PluginService commit()', () => {
	it('serializes overlapping commits and preserves plugin state', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry
		const summaries: any[] = []
		ctx.registry.afterCommit((summary) => {
			summaries.push(summary)
		})

		const slowInit = createDeferred()
		let slowInitCalled = false

		@Plugin({ name: 'SlowPlugin' })
		class SlowPlugin extends BasePlugin {
			override async init(): Promise<void> {
				slowInitCalled = true
				await slowInit.promise
			}
		}

		let firstResolved = false
		let secondResolved = false

		pluginRegistry.registerPlugin(SlowPlugin)
		const first = ctx.registry.commit().then((result) => {
			firstResolved = true
			return result
		})

		while (!slowInitCalled) {
			await new Promise((resolve) => setTimeout(resolve, 0))
		}

		pluginRegistry.registerPlugin(PluginB)
		const second = ctx.registry.commit().then((result) => {
			secondResolved = true
			return result
		})

		await new Promise((resolve) => setTimeout(resolve, 10))
		expect(firstResolved).toBe(false)
		expect(secondResolved).toBe(false)

		slowInit.resolve()

		const [firstResult, secondResult] = await Promise.all([first, second])

		expect(firstResolved).toBe(true)
		expect(secondResolved).toBe(true)
		expect(firstResult.ok).toBe(true)
		expect(secondResult.ok).toBe(true)

		expect(summaries.length).toBe(2)
		expect(summaries[0]?.added).toEqual([SlowPlugin])
		expect(new Set(summaries[1]?.added)).toEqual(new Set([PluginB]))

		const lastContainer = ctx.registry.pluginRegistry.lastContainer
		expect(lastContainer).toBeDefined()
		expect(lastContainer!.services.has(SlowPlugin)).toBe(true)
		expect(lastContainer!.services.has(PluginB)).toBe(true)
	})

	it('captures failing plugins and clears singletons for retries', async () => {
		const ctx = new Context()
		const { pluginRegistry } = ctx.registry

		@Plugin({ name: 'ThrowPlugin' })
		class ThrowPlugin extends BasePlugin {
			override init(): void {
				throw new Error('boom')
			}
		}

		pluginRegistry.registerPlugin(ThrowPlugin)
		const result = await ctx.registry.commit()
		expect(result.ok).toBe(true)

		const summary = ctx.registry.lastCommit
		expect(summary?.failed).toContain(ThrowPlugin)
		expect(summary?.added).toContain(ThrowPlugin)
		expect(ctx.registry.pluginRegistry.singletons.has(ThrowPlugin)).toBe(false)
	})
})
