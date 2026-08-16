import { BasePlugin, Plugin, assertPluginLifecycleIssue, withCoreHost } from '@pluxel/core/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type LateMode = 'cleanup' | 'cleanup-failure'

let lateMode: LateMode = 'cleanup'
let lateCleanupRuns = 0
let lateInitPromise: Promise<void>
let resolveLateInit: () => void
let rejectLateInit: (error: unknown) => void

function resetLateInit(mode: LateMode): void {
	lateMode = mode
	lateCleanupRuns = 0
	lateInitPromise = new Promise<void>((resolve, reject) => {
		resolveLateInit = resolve
		rejectLateInit = reject
	})
}

resetLateInit('cleanup')

@Plugin({ displayName: 'Late init', startTimeoutMs: 15 })
class LateInitPlugin extends BasePlugin {
	override async init() {
		await lateInitPromise
		return () => {
			lateCleanupRuns++
			if (lateMode === 'cleanup-failure') throw new Error('late cleanup boom')
		}
	}
}

describe('late init settlement', () => {
	beforeEach(() => resetLateInit('cleanup'))

	it('never resurrects a timed-out generation and immediately runs its returned cleanup', async () => {
		await withCoreHost(
			async (host) => {
				host.add(LateInitPlugin)
				const summary = await host.commitAllowFail()
				expect(host.isRunning(LateInitPlugin)).toBe(false)
				assertPluginLifecycleIssue(summary, LateInitPlugin, {
					phase: 'start',
					kind: 'start-failed',
					message: 'start timeout',
				})

				resolveLateInit()
				await vi.waitFor(() => expect(lateCleanupRuns).toBe(1))
				expect(host.isRunning(LateInitPlugin)).toBe(false)
			},
			{ registry: { drainTimeoutMs: 20 } },
		)
	})

	it('appends a late rejection to the same lifecycle report', async () => {
		await withCoreHost(
			async (host) => {
				host.add(LateInitPlugin)
				const summary = await host.commitAllowFail()
				rejectLateInit(new Error('late init boom'))

				await vi.waitFor(() =>
					assertPluginLifecycleIssue(summary, LateInitPlugin, {
						phase: 'start',
						kind: 'start-failed',
						message: 'late init boom',
					}),
				)
				expect(host.isRunning(LateInitPlugin)).toBe(false)
			},
			{ registry: { drainTimeoutMs: 20 } },
		)
	})

	it('reports a late returned-cleanup failure as a drain issue', async () => {
		resetLateInit('cleanup-failure')
		await withCoreHost(
			async (host) => {
				host.add(LateInitPlugin)
				const summary = await host.commitAllowFail()
				resolveLateInit()

				await vi.waitFor(() =>
					assertPluginLifecycleIssue(summary, LateInitPlugin, {
						phase: 'drain',
						kind: 'drain-failed',
						message: 'late cleanup boom',
					}),
				)
				expect(lateCleanupRuns).toBe(1)
			},
			{ registry: { drainTimeoutMs: 20 } },
		)
	})
})
