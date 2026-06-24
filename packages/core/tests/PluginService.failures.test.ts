import { describe, expect, it } from 'vitest'

import {
	BasePlugin,
	type CommitSummary,
	Plugin,
	assertPluginLifecycleIssue,
	pluginLifecycleIssuePlugins,
	setParamToken,
	withCoreHost,
} from '@pluxel/core/test'

describe('PluginService failure reporting', () => {
	it('commitStrict publishes failure details through afterCommit before returning an error', async () => {
		await withCoreHost(async (host) => {
			const afterCommit: CommitSummary[] = []

			host.ctx.on('afterCommit', (summary) => {
				afterCommit.push(summary)
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
			expect(pluginLifecycleIssuePlugins(afterCommit[0]!)).toEqual(['STRICT-FAIL-A'])
			expect(pluginLifecycleIssuePlugins(host.ctx.registry.lastCommit!)).toEqual(['STRICT-FAIL-A'])
			assertPluginLifecycleIssue(host.ctx.registry.lastCommit!, A, {
				phase: 'start',
				kind: 'start-failed',
				message: 'boom',
			})
			expect(host.get(A)).toBeUndefined()
			expect(host.isRunning(A)).toBe(false)
		})
	})

	it('reports only the failed dependency subtree while leaving independent plugins running', async () => {
		await withCoreHost(async (host) => {
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
			expect(new Set(pluginLifecycleIssuePlugins(summary))).toEqual(
				new Set(['FAIL-SUBTREE-A', 'FAIL-SUBTREE-B']),
			)
			expect(pluginLifecycleIssuePlugins(summary, { kind: 'dependency-blocked' })).toEqual([
				'FAIL-SUBTREE-B',
			])
			assertPluginLifecycleIssue(summary, A, {
				phase: 'start',
				kind: 'start-failed',
				message: 'boom',
			})
			assertPluginLifecycleIssue(summary, B, {
				phase: 'dependency',
				kind: 'dependency-blocked',
				blockedBy: A,
			})
			expect(pluginLifecycleIssuePlugins(summary)).not.toContain('FAIL-SUBTREE-C')
			expect(host.isRunning(A)).toBe(false)
			expect(host.isRunning(B)).toBe(false)
			expect(host.isRunning(C)).toBe(true)
			expect(independentStarted).toBe(1)
		})
	})
})
