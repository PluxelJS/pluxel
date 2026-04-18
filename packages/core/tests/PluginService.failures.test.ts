import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, setParamToken, withHost } from '@pluxel/test'

describe('PluginService failure reporting', () => {
	it('commitStrict preserves failure summary and emits commitFailed for failed start', async () => {
		await withHost(async (host) => {
			const afterCommit: Array<{ failed: unknown[] }> = []
			const commitFailed: unknown[][] = []

			host.ctx.on('afterCommit', (summary) => {
				afterCommit.push(summary as { failed: unknown[] })
			})
			host.ctx.on('commitFailed', (failed) => {
				commitFailed.push([...((failed as Set<unknown>).values())])
			})

			@Plugin({ name: 'STRICT-FAIL-A' })
			class A extends BasePlugin {
				override init(): void {
					throw new Error('boom')
				}
			}

			host.add(A)
			const failed = await host.ctx.registry.commitStrict()

			// Strict mode still publishes commit-side observability before surfacing the error result.
			expect(failed.ok).toBe(false)
			expect(afterCommit).toHaveLength(1)
			expect(afterCommit[0]!.failed).toEqual([A])
			expect(commitFailed).toEqual([[A]])
			expect(host.ctx.registry.lastCommit?.failed).toEqual([A])
			expect(host.get(A)).toBeUndefined()
			expect(host.isRunning(A)).toBe(false)
		})
	})

	it('reports only the failed dependency subtree while leaving independent plugins running', async () => {
		await withHost(async (host) => {
			let independentStarted = 0

			@Plugin({ name: 'FAIL-SUBTREE-A' })
			class A extends BasePlugin {
				override init(): void {
					throw new Error('boom')
				}
			}

			@Plugin({ name: 'FAIL-SUBTREE-B' })
			class B extends BasePlugin {
				constructor(_dep: A) {
					super()
				}
			}
			setParamToken(B, 0, A)

			@Plugin({ name: 'FAIL-SUBTREE-C' })
			class C extends BasePlugin {
				override init(): void {
					independentStarted++
				}
			}

			host.add([A, B, C])
			const summary = await host.commitAllowFail()

			// Only the failing root and its dependency chain should be marked failed.
			expect(new Set(summary.failed)).toEqual(new Set([A, B]))
			expect(summary.failed).not.toContain(C)
			expect(host.isRunning(A)).toBe(false)
			expect(host.isRunning(B)).toBe(false)
			expect(host.isRunning(C)).toBe(true)
			expect(independentStarted).toBe(1)
		})
	})
})
