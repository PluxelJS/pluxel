import { BasePlugin, Plugin, assertPluginLifecycleIssue, withCoreHost } from '@pluxel/core/test'
import { requirePluginService } from '@pluxel/core/internal'
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
			{ plugins: { drainTimeoutMs: 20 } },
		)
	})

	it('publishes a frozen successor for a late rejection without mutating the first summary', async () => {
		await withCoreHost(
			async (host) => {
				const registry = requirePluginService(host.ctx)
				const publications: unknown[] = []
				const unsubscribe = registry.subscribeCommitted((published) => publications.push(published))
				host.ctx.effects.defer(unsubscribe)
				host.add(LateInitPlugin)
				const summary = await host.commitAllowFail()
				rejectLateInit(new Error('late init boom'))

				await vi.waitFor(() => expect(registry.lastCommit).not.toBe(summary))
				const successor = registry.lastCommit!
				assertPluginLifecycleIssue(successor, LateInitPlugin, {
					phase: 'start',
					kind: 'start-failed',
					message: 'late init boom',
				})
				expect(
					summary.lifecycleReport.issues.some((issue) => issue.message === 'late init boom'),
				).toBe(false)
				expect(Object.isFrozen(successor)).toBe(true)
				expect(Object.isFrozen(successor.lifecycleReport)).toBe(true)
				expect(Object.isFrozen(successor.lifecycleReport.issues)).toBe(true)
				expect(publications).toEqual([summary, successor])
				expect(host.isRunning(LateInitPlugin)).toBe(false)
			},
			{ plugins: { drainTimeoutMs: 20 } },
		)
	})

	it('publishes a frozen successor for a late returned-cleanup failure', async () => {
		resetLateInit('cleanup-failure')
		await withCoreHost(
			async (host) => {
				const registry = requirePluginService(host.ctx)
				host.add(LateInitPlugin)
				const summary = await host.commitAllowFail()
				resolveLateInit()

				await vi.waitFor(() => expect(registry.lastCommit).not.toBe(summary))
				const successor = registry.lastCommit!
				assertPluginLifecycleIssue(successor, LateInitPlugin, {
					phase: 'drain',
					kind: 'drain-failed',
					message: 'late cleanup boom',
				})
				expect(
					summary.lifecycleReport.issues.some((issue) => issue.message === 'late cleanup boom'),
				).toBe(false)
				expect(lateCleanupRuns).toBe(1)
			},
			{ plugins: { drainTimeoutMs: 20 } },
		)
	})
})
