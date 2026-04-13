import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, setParamToken, withHost } from '@pluxel/test'

function defineDependentPair(prefix: string) {
	@Plugin({ name: `${prefix}-A` })
	class A extends BasePlugin {}

	@Plugin({ name: `${prefix}-B` })
	class B extends BasePlugin {
		constructor(public readonly dep: A) {
			super()
		}
	}
	setParamToken(B, 0, A)

	return { A, B }
}

async function expectCascadeUnregisterFromDraft(opts?: { invalidateDraftFirst?: boolean }) {
	await withHost(async (host) => {
		const { A, B } = defineDependentPair(
			opts?.invalidateDraftFirst ? 'CASCADE-RECOVER' : 'CASCADE-DRAFT',
		)

		host.add(A)
		await host.commit()

		host.add(B)
		if (opts?.invalidateDraftFirst) {
			host.ctx.registry.unregister(A, { cascadeDependents: false })
		}
		host.remove(A)

		const summary = await host.commit()

		expect(summary.added).toEqual([])
		expect(summary.removed).toEqual([A])
		expect(summary.failed).toEqual([])
		expect(new Set(host.plugins())).toEqual(new Set())
		expect(host.isRunning(A)).toBe(false)
		expect(host.isRunning(B)).toBe(false)
	})
}

describe('PluginService cascade options', () => {
	it('rejects non-cascading unregisters that would leave a broken graph and restores the committed draft', async () => {
		await withHost(async (host) => {
			const { A, B } = defineDependentPair('CASCADE-UNREG')

			host.add([A, B])
			await host.commit()

			// Non-cascading unregister is allowed at the draft layer, but commit must reject
			// the resulting broken graph and keep the last committed state intact.
			host.ctx.registry.unregister(A, { cascadeDependents: false })
			await expect(host.commit()).rejects.toThrow()

			expect(host.ctx.registry.isRegistered(A)).toBe(true)
			expect(host.ctx.registry.isRegistered(B)).toBe(true)
			expect(host.isRunning(A)).toBe(true)
			expect(host.isRunning(B)).toBe(true)
			expect(new Set(host.plugins())).toEqual(new Set([A, B]))
		})
	})

	it('cascades unregister across dependents added in the current draft', async () => {
		await expectCascadeUnregisterFromDraft()
	})

	it('still cascades unregister from an invalid draft where the root provider was already removed', async () => {
		await expectCascadeUnregisterFromDraft({ invalidateDraftFirst: true })
	})

	it('restart without cascading only restarts the target plugin', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'CASCADE-RESTART-A' })
			class A extends BasePlugin {
				public readonly id = Symbol('a')
			}

			@Plugin({ name: 'CASCADE-RESTART-B' })
			class B extends BasePlugin {
				constructor(public readonly dep: A) {
					super()
				}
			}
			setParamToken(B, 0, A)

			host.add([A, B])
			await host.commit()

			const firstA = host.require(A)
			const firstB = host.require(B)

			// Explicit opt-out keeps dependent instances stable even though their dependency restarts.
			host.restart(A, { cascadeDependents: false })
			const summary = await host.commit()

			const secondA = host.require(A)
			const secondB = host.require(B)

			expect(summary.added).toEqual([])
			expect(summary.removed).toEqual([])
			expect(summary.replaced).toEqual([])
			expect(summary.failed).toEqual([])
			expect(summary.touched).toEqual([A])
			expect(secondA).not.toBe(firstA)
			expect(secondB).toBe(firstB)
		})
	})

	it('restart fails early when the draft no longer has a provider for the requested root', async () => {
		await withHost(async (host) => {
			const { A, B } = defineDependentPair('CASCADE-RESTART-MISSING')

			host.add(A)
			await host.commit()

			host.add(B)
			host.ctx.registry.unregister(A, { cascadeDependents: false })

			expect(() => host.restart(A)).toThrow(/unloaded Plugin/)
		})
	})

	it('replace without cascading leaves existing dependents running and limits touched scope', async () => {
		await withHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'CASCADE-REPLACE-A' })
			class A extends Abs {}

			@Plugin(Abs, { name: 'CASCADE-REPLACE-B' })
			class B extends Abs {}

			@Plugin({ name: 'CASCADE-REPLACE-C' })
			class C extends BasePlugin {
				constructor(public readonly dep: Abs) {
					super()
				}
			}
			setParamToken(C, 0, Abs)

			host.add([A, C], { provideBase: true })
			await host.commit()

			const firstC = host.require(C)

			// The graph retargets aliases immediately, but without cascade the already-running
			// dependent instance is left untouched until it is explicitly restarted later.
			host.replace(A, B, { provideBase: true, cascadeDependents: false })
			const summary = await host.commit()

			expect(summary.replaced).toEqual([{ from: A, to: B }])
			expect(new Set(summary.touched)).toEqual(new Set([A, B]))
			expect(host.require(C)).toBe(firstC)
			expect(host.ctx.registry.graph.resolve(Abs)).toBe(B)
			expect(host.ctx.registry.graph.resolve(A)).toBe(B)
		})
	})
})
