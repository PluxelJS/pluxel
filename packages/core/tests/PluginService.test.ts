import { describe, expect, it } from 'bun:test'

import { BasePlugin, Plugin, setParamToken, withTestHost } from '@pluxel/core/test'
import { PluginA, PluginB, PluginC } from './plugins'

function createDeferred() {
	let resolve!: () => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

async function waitUntil(cond: () => boolean, opts?: { timeoutMs?: number }) {
	const timeoutMs = opts?.timeoutMs ?? 1_000
	const start = Date.now()
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error('waitUntil timeout')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

describe('PluginService commit()', () => {
	it('ready-queue starts dependents without batch barriers', async () => {
		await withTestHost(
			async (host) => {
				const events: string[] = []

				const aGate = createDeferred()
				const cGate = createDeferred()

				let aStarted = false
				let cStarted = false
				let bStarted = false

				@Plugin({ name: 'RQ-A' })
				class A extends BasePlugin {
					override async init(): Promise<void> {
						aStarted = true
						events.push('A:start')
						await aGate.promise
						events.push('A:done')
					}
				}

				@Plugin({ name: 'RQ-C' })
				class C extends BasePlugin {
					override async init(): Promise<void> {
						cStarted = true
						events.push('C:start')
						await cGate.promise
						events.push('C:done')
					}
				}

				@Plugin({ name: 'RQ-B' })
				class B extends BasePlugin {
					constructor(public a: A) {
						super()
					}

					override init(): void {
						bStarted = true
						events.push('B:init')
					}
				}
				setParamToken(B, 0, A)

				host.registerAll(A, C, B)
				const attemptPromise = host.tryCommit()

				await waitUntil(() => aStarted && cStarted)

				aGate.resolve()
				await waitUntil(() => bStarted)
				expect(events).not.toContain('C:done')

				cGate.resolve()
				const attempt = await attemptPromise
				expect(attempt.ok).toBe(true)
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 2 } },
		)
	})

	it('batch strategy keeps depth barriers', async () => {
		await withTestHost(
			async (host) => {
				const events: string[] = []

				const aGate = createDeferred()
				const cGate = createDeferred()

				let aStarted = false
				let cStarted = false
				let bStarted = false

				@Plugin({ name: 'BATCH-A' })
				class A extends BasePlugin {
					override async init(): Promise<void> {
						aStarted = true
						events.push('A:start')
						await aGate.promise
						events.push('A:done')
					}
				}

				@Plugin({ name: 'BATCH-C' })
				class C extends BasePlugin {
					override async init(): Promise<void> {
						cStarted = true
						events.push('C:start')
						await cGate.promise
						events.push('C:done')
					}
				}

				@Plugin({ name: 'BATCH-B' })
				class B extends BasePlugin {
					constructor(public a: A) {
						super()
					}

					override init(): void {
						bStarted = true
						events.push('B:init')
					}
				}
				setParamToken(B, 0, A)

				host.registerAll(A, C, B)
				const attemptPromise = host.tryCommit()

				await waitUntil(() => aStarted && cStarted)

				aGate.resolve()
				await new Promise((resolve) => setTimeout(resolve, 10))
				expect(bStarted).toBe(false)
				expect(events).not.toContain('B:init')

				cGate.resolve()
				await waitUntil(() => bStarted)

				const attempt = await attemptPromise
				expect(attempt.ok).toBe(true)
			},
			{ registry: { startStrategy: 'batch' } },
		)
	})

	it('ready-queue enforces bounded concurrency', async () => {
		await withTestHost(
			async (host) => {
				let active = 0
				let maxActive = 0
				const unblockers: Array<() => void> = []

				const makeSlow = (name: string) => {
					const gate = createDeferred()
					@Plugin({ name })
					class Slow extends BasePlugin {
						override async init(): Promise<void> {
							active++
							maxActive = Math.max(maxActive, active)
							unblockers.push(gate.resolve)
							try {
								await gate.promise
							} finally {
								active--
							}
						}
					}
					return Slow
				}

				const S1 = makeSlow('S1')
				const S2 = makeSlow('S2')
				const S3 = makeSlow('S3')

				host.registerAll(S1, S2, S3)
				const attemptPromise = host.tryCommit()

				await waitUntil(() => active === 2 && unblockers.length === 2)
				expect(maxActive).toBe(2)

				// Free up one slot, third plugin should start.
				unblockers[0]!()
				await waitUntil(() => unblockers.length === 3)
				expect(maxActive).toBe(2)

				// Finish remaining.
				for (const u of unblockers) u()
				const attempt = await attemptPromise
				expect(attempt.ok).toBe(true)
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 2 } },
		)
	})

	it('ready-queue fails fast on dependency chain', async () => {
		await withTestHost(
			async (host) => {
				let bInit = false
				let cInit = false

				@Plugin({ name: 'FF-A' })
				class A extends BasePlugin {
					override init(): void {
						throw new Error('boom')
					}
				}

				@Plugin({ name: 'FF-B' })
				class B extends BasePlugin {
					constructor(_a: A) {
						super()
					}
					override init(): void {
						bInit = true
					}
				}
				setParamToken(B, 0, A)

				@Plugin({ name: 'FF-C' })
				class C extends BasePlugin {
					constructor(_b: B) {
						super()
					}
					override init(): void {
						cInit = true
					}
				}
				setParamToken(C, 0, B)

				host.registerAll(A, B, C)
				const summary = await host.commit()

				expect(summary.failed).toContain(A)
				expect(summary.failed).toContain(B)
				expect(summary.failed).toContain(C)
				expect(bInit).toBe(false)
				expect(cInit).toBe(false)
				expect(host.get(B)).toBeUndefined()
				expect(host.get(C)).toBeUndefined()
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 3 } },
		)
	})

	it('teardown stops dependents before parents', async () => {
		await withTestHost(
			async (host) => {
				const events: string[] = []

				@Plugin({ name: 'Stop-A' })
				class A extends BasePlugin {
					override stop(): void {
						events.push('A:stop')
					}
				}

				const bStopGate = createDeferred()

				@Plugin({ name: 'Stop-B' })
				class B extends BasePlugin {
					constructor(_a: A) {
						super()
					}
					override async stop(): Promise<void> {
						events.push('B:stop')
						await bStopGate.promise
					}
				}
				setParamToken(B, 0, A)

				host.registerAll(A, B)
				await host.commitStrict()
				expect(host.get(A)).toBeDefined()
				expect(host.get(B)).toBeDefined()
				expect(host.isRunning(A)).toBe(true)
				expect(host.isRunning(B)).toBe(true)

				events.length = 0
				host.unregister(A) // cascades to dependents, so A and B are both stopped
				const attemptPromise = host.tryCommit()

				await waitUntil(() => events.includes('B:stop'))
				expect(events.includes('A:stop')).toBe(false)

				bStopGate.resolve()
				const attempt = await attemptPromise
				expect(attempt.ok).toBe(true)
				expect(events).toEqual(['B:stop', 'A:stop'])
			},
			{ registry: { stopConcurrency: 2 } },
		)
	})

	it('can unregister during an active commit and still stop on the next commit', async () => {
		await withTestHost(async (host) => {
			const summaries: any[] = []
			host.ctx.on('afterCommit', (summary) => {
				summaries.push(summary)
			})

			let stopped = 0

			@Plugin({ name: 'SelfUnloader' })
			class SelfUnloader extends BasePlugin {
				override init(): void {
					this.ctx.registry.unregister(SelfUnloader)
					void this.ctx.registry.commit()
				}

				override stop(): void {
					stopped++
				}
			}

			host.register(SelfUnloader)
			const first = await host.tryCommit()
			expect(first.ok).toBe(true)

			await waitUntil(() => summaries.length >= 2)

			expect(stopped).toBe(1)
			expect(host.isRunning(SelfUnloader)).toBe(false)
			expect(host.get(SelfUnloader)).toBeUndefined()
		})
	})

	it('serializes overlapping commits and preserves plugin state', async () => {
		await withTestHost(async (host) => {
			const summaries: any[] = []
			host.ctx.on('afterCommit', (summary) => {
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

			host.register(SlowPlugin)
			const first = host.tryCommit().then((result) => {
				firstResolved = true
				return result
			})

			while (!slowInitCalled) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}

			host.register(PluginB)
			const second = host.tryCommit().then((result) => {
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

			const lastContainer = host.lastCommit()?.container
			expect(lastContainer).toBeDefined()
			expect(lastContainer!.services.has(SlowPlugin)).toBe(true)
			expect(lastContainer!.services.has(PluginB)).toBe(true)
		})
	})

	it('captures failing plugins and clears singletons for retries', async () => {
		await withTestHost(async (host) => {
			@Plugin({ name: 'ThrowPlugin' })
			class ThrowPlugin extends BasePlugin {
				override init(): void {
					throw new Error('boom')
				}
			}

			host.register(ThrowPlugin)
			const summary = await host.commit()

			expect(summary?.failed).toContain(ThrowPlugin)
			expect(summary?.added).toContain(ThrowPlugin)
			expect(host.get(ThrowPlugin)).toBeUndefined()
		})
	})

	it('allows optional deps to run logic after commit', async () => {
		await withTestHost(async (host) => {
			const events: string[] = []

			@Plugin({ name: 'OptionalProvider' })
			class OptionalProvider extends BasePlugin {
				override init(): void {
					events.push('provider:init')
				}
			}

			@Plugin({ name: 'OptionalConsumer' })
			class OptionalConsumer extends BasePlugin {
				override init(): void {
					events.push('consumer:init')
					this.ctx.registry.optional(OptionalProvider, (dep) => {
						events.push(dep ? 'after:hit' : 'after:miss')
					})
				}
			}

			host.register(OptionalConsumer)
			await host.commitStrict()
			await Promise.resolve()
			expect(events).toEqual(['consumer:init', 'after:miss'])

			host.register(OptionalProvider)
			await host.commitStrict()
			await Promise.resolve()

			expect(events).toEqual(['consumer:init', 'after:miss', 'provider:init', 'after:hit'])

			const immediate: string[] = []
			host.optional(OptionalProvider, (dep) => {
				immediate.push(dep ? 'now:hit' : 'now:miss')
			})
			await Promise.resolve()
			expect(immediate).toEqual(['now:hit'])
		})
	})

	it('optional handles dynamic import errors and still runs effect', async () => {
		await withTestHost(async (host) => {
			const ctx = host.ctx as any
			const logs: unknown[][] = []
			const originalWarn = ctx.logger.warn
			ctx.logger.warn = ((...args: unknown[]) => {
				logs.push(args)
			}) as any

			const events: string[] = []

			await host.optional(
				() => Promise.reject(new Error('dyn import fail')),
				(dep) => {
					events.push(dep ? 'promise:hit2' : 'promise:miss2')
				},
			)
			await Promise.resolve()
			expect(events).toEqual(['promise:miss2'])
			expect(logs.length).toBeGreaterThanOrEqual(1)
			ctx.logger.warn = originalWarn
		})
	})

	it('optional importer validates plugin exports and reflects running instances', async () => {
		await withTestHost(async (host) => {
			const ctx = host.ctx as any
			host.register(PluginB)
			await host.commitStrict()

			const hits: string[] = []
			await host.optional(
				() => Promise.resolve(PluginB),
				(instance) => {
					if (instance) hits.push((instance as any).constructor.name)
				},
			)
			await Promise.resolve()
			expect(hits).toEqual(['PluginB'])

			const logs: unknown[][] = []
			const originalWarn = ctx.logger.warn
			ctx.logger.warn = ((...args: unknown[]) => logs.push(args)) as any

			await host.optional(
				() => Promise.resolve([() => {}]),
				(_instances) => void hits.push('none'),
			)
			expect(hits[hits.length - 1]).toBe('none')
			expect(logs.length).toBeGreaterThan(0)
			ctx.logger.warn = originalWarn
		})
	})

	it('optional injects caller context like a required dependency', async () => {
		await withTestHost(async (host) => {
			const callerCtxs: any[] = []
			let consumerCtx: any | undefined

			@Plugin({ name: 'OptionalCallerProvider' })
			class OptionalCallerProvider extends BasePlugin {
				record(): void {
					if (this.ctx.caller) callerCtxs.push(this.ctx.caller)
				}
			}

			@Plugin({ name: 'OptionalCallerConsumer' })
			class OptionalCallerConsumer extends BasePlugin {
				override init(): void {
					consumerCtx = this.ctx
					this.ctx.registry.optional(OptionalCallerProvider, (p) => {
						if (p?.ctx.caller) callerCtxs.push(p.ctx.caller)
						p?.record()
					})
				}
			}

			host.register(OptionalCallerProvider)
			await host.commitStrict()

			host.register(OptionalCallerConsumer)
			await host.commitStrict()
			await Promise.resolve()

			expect(callerCtxs.length).toBeGreaterThanOrEqual(1)
			for (const caller of callerCtxs) {
				expect(caller).toBe(consumerCtx)
			}
		})
	})

	it('retries failed plugins on later commits even without container changes', async () => {
		await withTestHost(async (host) => {
			let attempt = 0
			const events: string[] = []

			@Plugin({ name: 'Flaky' })
			class Flaky extends BasePlugin {
				override init(): void {
					attempt++
					if (attempt === 1) throw new Error('boom')
					events.push('ok')
				}
			}

			host.register(Flaky)

			const first = await host.tryCommit()
			expect(first.ok).toBe(true)
			expect(host.lastCommit()?.failed).toContain(Flaky)
			expect(host.isRunning(Flaky)).toBe(false)

			// No container changes, but Flaky should be retried.
			const second = await host.tryCommit()
			expect(second.ok).toBe(true)
			expect(host.isRunning(Flaky)).toBe(true)
			expect(events).toEqual(['ok'])
		})
	})

	it('updates registered plugin set across commits', async () => {
		await withTestHost(async (host) => {
			const readPluginSet = () => new Set<any>(host.listPlugins())

			// Bun's TS transpilation may not emit `design:paramtypes` metadata;
			// set tokens explicitly to keep DI behavior deterministic in tests.
			setParamToken(PluginA, 0, PluginB)

			host.registerAll(PluginB, PluginC, PluginA)
			await host.commitStrict()

			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC, PluginA]))

			host.restart(PluginA)
			host.unregister(PluginA)
			await host.commitStrict()
			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC]))

			host.register(PluginA)
			await host.commitStrict()
			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC, PluginA]))
			expect(host.isRunning(PluginA)).toBe(true)

			host.unregister(PluginA)
			await host.commitStrict()
			expect(readPluginSet()).toEqual(new Set([PluginB, PluginC]))
			expect(host.isRunning(PluginA)).toBe(false)
		})
	})
})
