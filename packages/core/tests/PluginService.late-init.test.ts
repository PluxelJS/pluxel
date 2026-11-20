import { createCoreContextHost } from '@pluxel/core/host'
import {
	BasePlugin,
	Plugin,
	assertPluginLifecycleIssue,
	createCoreInternalTestHost,
	type CommitSummary,
} from '@pluxel/core/internal/test'
import { expect, it, vi } from 'vitest'

let late: ReturnType<typeof Promise.withResolvers<() => void>>

@Plugin({ startTimeoutMs: 15 })
class LatePlugin extends BasePlugin {
	override init() {
		return late.promise
	}
}

it('drains a cleanup returned after timeout without finalizing or publishing that generation', async () => {
	late = Promise.withResolvers()
	const cleaned = Promise.withResolvers<void>()
	const finalizeGeneration = vi.fn()
	await using host = createCoreInternalTestHost(
		{ execution: { drainTimeoutMs: 20 } },
		{
			createRootContext: (config) =>
				createCoreContextHost({
					...config,
					createLifecycleHooks: () => ({ finalizeGeneration }),
				}).createRoot(),
		},
	)
	host.add(LatePlugin)
	const timedOut = await host.commitAllowFail()
	late.resolve(cleaned.resolve)
	assertPluginLifecycleIssue(timedOut, LatePlugin, {
		kind: 'start-failed',
		message: 'start timeout',
	})
	await cleaned.promise
	expect(finalizeGeneration).not.toHaveBeenCalled()
	expect(host.get(LatePlugin)).toBeUndefined()
})

it.each(['start-failed', 'drain-failed'] as const)(
	'publishes a successor report for a late %s issue without rewriting the timeout report',
	async (kind) => {
		late = Promise.withResolvers()
		await using host = createCoreInternalTestHost({ execution: { drainTimeoutMs: 20 } })
		host.add(LatePlugin)
		const timedOut = await host.commitAllowFail()
		const originalIssues = [...timedOut.lifecycleReport.issues]
		assertPluginLifecycleIssue(timedOut, LatePlugin, {
			kind: 'start-failed',
			message: 'start timeout',
		})
		const updated = Promise.withResolvers<CommitSummary>()
		host.ctx.effects.defer(host.pluginService.subscribeCommitted(updated.resolve))

		const error = new Error('late failure')
		if (kind === 'start-failed') late.reject(error)
		else
			late.resolve(() => {
				throw error
			})

		const successor = await updated.promise
		expect(successor).not.toBe(timedOut)
		assertPluginLifecycleIssue(successor, LatePlugin, { kind, message: error.message })
		expect(timedOut.lifecycleReport.issues).toEqual(originalIssues)
		expect(Object.isFrozen(successor.lifecycleReport.issues)).toBe(true)
		expect(host.get(LatePlugin)).toBeUndefined()
	},
)
