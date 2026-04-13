import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, setParamToken, withHost } from '@pluxel/test'
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

function collectCommitSummaries(host: {
	ctx: { on: (event: 'afterCommit', cb: (summary: unknown) => void) => void }
}) {
	const summaries: unknown[] = []
	host.ctx.on('afterCommit', (summary) => {
		summaries.push(summary)
	})
	return summaries
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
	it('resolves aliases through the committed graph', async () => {
		await withHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'BIND-A' })
			class A extends Abs {}

			await host.start(A, { provideBase: true })
			expect(host.ctx.registry.graph.resolve(Abs)).toBe(A)
			expect(host.get(Abs)).toBeInstanceOf(A)
		})
	})

	it('replaces a plugin implementation while keeping old tokens resolvable', async () => {
		await withHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'REPL-A' })
			class A extends Abs {}

			@Plugin(Abs, { name: 'REPL-B' })
			class B extends Abs {}

			await host.start(A, { provideBase: true })
			host.replace(A, B, { provideBase: true })
			await host.commit()

			expect(host.ctx.registry.graph.resolve(Abs)).toBe(B)
			expect(host.ctx.registry.graph.resolve(A)).toBe(B)
			expect(host.get(Abs)).toBeInstanceOf(B)
			expect(host.get(A)).toBeInstanceOf(B)
			expect(host.get(B)).toBeInstanceOf(B)
		})
	})

	it('reports replacement pairs and touched subtree for root replacement', async () => {
		await withHost(async (host) => {
			abstract class Abs extends BasePlugin {}

			@Plugin(Abs, { name: 'PAIR-A' })
			class A extends Abs {}

			@Plugin(Abs, { name: 'PAIR-B' })
			class B extends Abs {}

			@Plugin({ name: 'PAIR-C' })
			class C extends BasePlugin {
				constructor(public readonly dep: Abs) {
					super()
				}
			}
			setParamToken(C, 0, Abs)

			host.add([A, C], { provideBase: true })
			await host.commit()

			host.replace(A, B, { provideBase: true })
			const summary = await host.commit()

			expect(summary.replaced).toEqual([{ from: A, to: B }])
			expect(new Set(summary.touched)).toEqual(new Set([A, B, C]))
			expect(host.ctx.registry.graph.resolve(Abs)).toBe(B)
			expect(host.ctx.registry.graph.resolve(A)).toBe(B)
			expect(host.get(C)?.dep).toBeInstanceOf(B)
		})
	})

	it('confirms no-op draft commits before publishing the summary graph', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'NOOP-A' })
			class A extends BasePlugin {}

			@Plugin({ name: 'NOOP-B' })
			class B extends BasePlugin {}

			await host.start(A)

			host.replace(A, B)
			host.replace(B, A)

			const summary = await host.commit()
			expect(summary.graph).toBe(host.ctx.registry.graph)
			expect(summary.graph.resolve(A)).toBe(A)

			const committedGraph = host.ctx.registry.graph
			const second = await host.commit()
			expect(second.graph).toBe(committedGraph)
			expect(second.added).toEqual([])
			expect(second.removed).toEqual([])
			expect(second.replaced).toEqual([])
			expect(second.failed).toEqual([])
			expect(second.touched).toEqual([])
		})
	})

	it('ready-queue starts dependents without batch barriers', async () => {
		await withHost(
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

				host.add([A, C, B])
				const commitPromise = host.commit()

				await waitUntil(() => aStarted && cStarted)

				aGate.resolve()
				await waitUntil(() => bStarted)
				expect(events).not.toContain('C:done')

				cGate.resolve()
				await commitPromise
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 2 } },
		)
	})

	it('batch strategy keeps depth barriers', async () => {
		await withHost(
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

				host.add([A, C, B])
				const commitPromise = host.commit()

				await waitUntil(() => aStarted && cStarted)

				aGate.resolve()
				await new Promise((resolve) => setTimeout(resolve, 10))
				expect(bStarted).toBe(false)
				expect(events).not.toContain('B:init')

				cGate.resolve()
				await waitUntil(() => bStarted)

				await commitPromise
			},
			{ registry: { startStrategy: 'batch' } },
		)
	})

	it('ready-queue enforces bounded concurrency', async () => {
		await withHost(
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

				host.add([S1, S2, S3])
				const commitPromise = host.commit()

				await waitUntil(() => active === 2 && unblockers.length === 2)
				expect(maxActive).toBe(2)

				// Free up one slot, third plugin should start.
				unblockers[0]!()
				await waitUntil(() => unblockers.length === 3)
				expect(maxActive).toBe(2)

				// Finish remaining.
				for (const u of unblockers) u()
				await commitPromise
			},
			{ registry: { startStrategy: 'ready-queue', startConcurrency: 2 } },
		)
	})

	it('ready-queue fails fast on dependency chain', async () => {
		await withHost(
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

				host.add([A, B, C])
				const summary = await host.commitAllowFail()

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

	it('respects global startTimeoutMs when no override is provided', async () => {
		await withHost(
			async (host) => {
				@Plugin({ name: 'TO-global' })
				class Slow extends BasePlugin {
					override async init(signal: AbortSignal): Promise<void> {
						await new Promise<void>((resolve, reject) => {
							const t = setTimeout(resolve, 50)
							signal.addEventListener(
								'abort',
								() => {
									clearTimeout(t)
									reject(new Error('aborted'))
								},
								{ once: true },
							)
						})
					}
				}

				host.add(Slow)
				const summary = await host.commitAllowFail()
				expect(summary.failed).toContain(Slow)
				expect(host.isRunning(Slow)).toBe(false)
			},
			{ registry: { startTimeoutMs: 10 } },
		)
	})

	it('allows per-plugin startTimeoutMs via @Plugin metadata', async () => {
		await withHost(
			async (host) => {
				@Plugin({ name: 'TO-meta', startTimeoutMs: 200 })
				class Slow extends BasePlugin {
					override async init(signal: AbortSignal): Promise<void> {
						await new Promise<void>((resolve, reject) => {
							const t = setTimeout(resolve, 50)
							signal.addEventListener(
								'abort',
								() => {
									clearTimeout(t)
									reject(new Error('aborted'))
								},
								{ once: true },
							)
						})
					}
				}

				host.add(Slow)
				await host.commit()
				expect(host.isRunning(Slow)).toBe(true)
			},
			{ registry: { startTimeoutMs: 10 } },
		)
	})

	it('can unregister during an active commit and still stop on the next commit', async () => {
		await withHost(async (host) => {
			const summaries: any[] = []
			host.ctx.on('afterCommit', (summary) => {
				summaries.push(summary)
			})

			let stopped = 0

			@Plugin({ name: 'SelfUnloader' })
			class SelfUnloader extends BasePlugin {
				override init(): void {
					void this.ctx.registry.shutdownSelf()
				}

				override stop(): void {
					stopped++
				}
			}

			host.add(SelfUnloader)
			await host.commit()

			await waitUntil(() => summaries.length >= 2)

			expect(stopped).toBe(1)
			expect(host.isRunning(SelfUnloader)).toBe(false)
			expect(host.get(SelfUnloader)).toBeUndefined()
		})
	})

	it('shutdownSelf() throws outside plugin context', async () => {
		await withHost(async (host) => {
			expect(() => host.ctx.registry.shutdownSelf()).toThrow('not in a plugin context')
		})
	})

	it('serializes overlapping commits and preserves plugin state', async () => {
		await withHost(async (host) => {
			const summaries = collectCommitSummaries(host) as Array<{
				added?: unknown[]
			}>

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

			host.add(SlowPlugin)
			const first = host.commit().then((result) => {
				firstResolved = true
				return result
			})

			while (!slowInitCalled) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}

			host.add(PluginB)
			const second = host.commit().then((result) => {
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
			expect(firstResult.failed).toEqual([])
			expect(secondResult.failed).toEqual([])

			expect(summaries.length).toBe(2)
			expect(summaries[0]?.added).toEqual([SlowPlugin])
			expect(new Set(summaries[1]?.added)).toEqual(new Set([PluginB]))

			const lastGraph = host.last()?.graph
			expect(lastGraph).toBeDefined()
			expect(lastGraph!.has(SlowPlugin)).toBe(true)
			expect(lastGraph!.has(PluginB)).toBe(true)
		})
	})

	it('captures failing plugins and clears singletons for retries', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'ThrowPlugin' })
			class ThrowPlugin extends BasePlugin {
				override init(): void {
					throw new Error('boom')
				}
			}

			host.add(ThrowPlugin)
			const summary = await host.commitAllowFail()

			expect(summary?.failed).toContain(ThrowPlugin)
			expect(summary?.added).toContain(ThrowPlugin)
			expect(host.get(ThrowPlugin)).toBeUndefined()
		})
	})

	it('retries failed plugins on later commits even without container changes', async () => {
		await withHost(async (host) => {
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

			host.add(Flaky)

			await host.commitAllowFail()
			expect(host.last()?.failed).toContain(Flaky)
			expect(host.isRunning(Flaky)).toBe(false)

			// No graph changes, but Flaky should be retried.
			await host.commit()
			expect(host.isRunning(Flaky)).toBe(true)
			expect(events).toEqual(['ok'])
		})
	})

	it('recovers from DI build failures on the next commit', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'MissingDep-B' })
			class B extends BasePlugin {}

			@Plugin({ name: 'MissingDep-A' })
			class A extends BasePlugin {
				constructor(public b: B) {
					super()
				}
			}
			setParamToken(A, 0, B)

			// Draft contains an invalid DI graph: A needs B but B is missing.
			host.add(A)
			await expect(host.commit()).rejects.toThrow()
			expect(host.isRunning(A)).toBe(false)
			expect(host.isRunning(B)).toBe(false)

			// Next commit should succeed after registering the missing provider.
			host.add([B, A])
			await host.commit()
			expect(host.isRunning(A)).toBe(true)
			expect(host.isRunning(B)).toBe(true)
		})
	})

})
