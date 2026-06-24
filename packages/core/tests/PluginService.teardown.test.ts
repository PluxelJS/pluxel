import { describe, expect, it } from 'vitest'

import {
	BasePlugin,
	Plugin,
	assertPluginLifecycleIssue,
	pluginLifecycleIssuePlugins,
	setParamToken,
	withCoreHost,
} from '@pluxel/core/test'

function createDeferred() {
	let resolve!: () => void
	const promise = new Promise<void>((res) => {
		resolve = res
	})
	return { promise, resolve }
}

describe('PluginService teardown ordering', () => {
	it('stops dependents before parents', async () => {
		await withCoreHost(
			async (host) => {
				const events: string[] = []

				@Plugin({ name: 'Stop-A' })
				class A extends BasePlugin {
					override stop(): void {
						events.push('A:stop')
					}
				}

				const bStopGate = createDeferred()
				const bStopped = createDeferred()

				@Plugin({ name: 'Stop-B' })
				class B extends BasePlugin {
					constructor(_a: A) {
						super()
					}

					override async stop(): Promise<void> {
						events.push('B:stop')
						bStopped.resolve()
						await bStopGate.promise
					}
				}
				setParamToken(B, 0, A)

				host.add([A, B])
				await host.commit()
				expect(host.isRunning(A)).toBe(true)
				expect(host.isRunning(B)).toBe(true)

				events.length = 0
				host.remove(A)
				const commitPromise = host.commit()

				await bStopped.promise
				expect(events).toEqual(['B:stop'])

				bStopGate.resolve()
				await commitPromise
				expect(events).toEqual(['B:stop', 'A:stop'])
			},
			{ registry: { stopConcurrency: 2 } },
		)
	})

	it('reports stop failures while continuing teardown', async () => {
		await withCoreHost(async (host) => {
			let stopped = false

			@Plugin({ name: 'StopFail' })
			class StopFail extends BasePlugin {
				override stop(): void {
					stopped = true
					throw new Error('stop boom')
				}
			}

			host.add(StopFail)
			await host.commit()

			host.remove(StopFail)
			const summary = await host.commitAllowFail()

			expect(stopped).toBe(true)
			expect(pluginLifecycleIssuePlugins(summary)).toEqual(['StopFail'])
			assertPluginLifecycleIssue(summary, StopFail, {
				phase: 'stop',
				kind: 'stop-failed',
				message: 'stop boom',
			})
		})
	})
})
