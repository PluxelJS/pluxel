import { describe, expect, it, vi } from 'vitest'
import '../../src/register-services'
import { BasePlugin, createRuntimeHost, Plugin, setParamToken } from '@pluxel/runtime/test'

import {
	collectEnabledButStopped,
	type EnabledButStoppedLookupContext,
	HmrExecutor,
} from '../../src/hmr/engine/pipeline'
import { enablePlugins, isEnabled } from '../support/runtime-state'

function defineParamTypes(ctor: unknown, paramTypes: unknown[]) {
	;(
		Reflect as { defineMetadata?: (key: string, value: unknown[], target: unknown) => void }
	).defineMetadata?.('design:paramtypes', paramTypes, ctor)
}

function createExecutor(
	ctx: ConstructorParameters<typeof HmrExecutor>[0],
	options: {
		importModule?: (id: string) => Promise<Record<string, unknown>> | Record<string, unknown>
		config?: Partial<ConstructorParameters<typeof HmrExecutor>[4]>
		path?: Partial<ConstructorParameters<typeof HmrExecutor>[2]>
	} = {},
) {
	const runner: ConstructorParameters<typeof HmrExecutor>[1] = {
		import: async (id: string) => options.importModule?.(id) ?? {},
	}
	const path = {
		variants: (id: string) => [id],
		variantsClean: (id: string) => [id],
		toClean: (id: string) => id,
		toVite: (id: string) => id,
		pretty: (id: string) => id,
		...options.path,
	} as ConstructorParameters<typeof HmrExecutor>[2]
	const timing: ConstructorParameters<typeof HmrExecutor>[3] = { start: () => () => 0 }

	return new HmrExecutor(ctx, runner, path, timing, {
		useRequireShims: false,
		dbgModules: null,
		...options.config,
	})
}

describe('HmrExecutor commit retry', () => {
	it('imports filesystem ids through /@fs while preserving the clean registry identity', async () => {
		const host = createRuntimeHost()
		try {
			const cleanId = '/repo/plugins/a/src/index.ts'
			const calls: string[] = []
			class Anchor extends BasePlugin {}
			Plugin({ name: 'Anchor' })(Anchor)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					calls.push(id)
					if (id === `/@fs${cleanId}`) return { Anchor }
					throw new Error(`unexpected id: ${id}`)
				},
				path: {
					variants: (id) => [id, `/@fs${id}`],
					variantsClean: (id) => [id, `/@fs${id}`],
				},
			})

			const out = await executor.runAndLoadAllClean([cleanId])
			expect(out?.commitResult.ok).toBe(true)
			expect(calls).toEqual([`/@fs${cleanId}`])
			expect(host.ctx.loader.api.anchors.has(cleanId)).toBe(true)
			expect(host.ctx.loader.api.registry.findModuleId('Anchor')).toBe(cleanId)
		} finally {
			await host.dispose()
		}
	})

	it('syncs runtime-reported affected modules before commit', async () => {
		const host = createRuntimeHost()
		try {
			let depSeq = 0
			let consumerSeq = 0
			let moduleItemsSeenDuringHmrCommit: Function[] = []

			class Dep extends BasePlugin {
				readonly seq = ++depSeq
			}
			Plugin({ name: 'Dep' })(Dep)

			class Consumer extends BasePlugin {
				readonly seq = ++consumerSeq

				constructor(readonly dep: Dep) {
					super()
				}
			}
			defineParamTypes(Consumer, [Dep])
			Plugin({ name: 'Consumer' })(Consumer)
			setParamToken(Consumer, 0, Dep)

			enablePlugins(host.ctx, 'Dep', 'Consumer')
			await host.ctx.loader.replaceModule('/dep.ts', { Dep })
			await host.ctx.loader.replaceModule('/consumer.ts', { Consumer })
			await host.commit()
			host.ctx.internalEvent.runtimeCommitted.on(
				(summary: { runtimeUpdate?: { reason?: string } }) => {
					if (summary.runtimeUpdate?.reason !== 'hmr') return
					moduleItemsSeenDuringHmrCommit = host.ctx.registry
						.listRuntimeModuleItems('/dep.ts')
						.map((item: { ctor: Function }) => item.ctor)
				},
			)

			const firstConsumer = host.get(Consumer)
			expect(firstConsumer?.seq).toBe(1)
			expect(firstConsumer?.dep.seq).toBe(1)

			class DepNext extends BasePlugin {
				readonly seq = ++depSeq
			}
			Plugin({ name: 'Dep' })(DepNext)

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/dep.ts')
					return { Dep: DepNext }
				},
			})

			const out = await executor.runAndLoadAllClean(['/dep.ts'])
			expect(out?.commitResult.ok).toBe(true)
			expect(new Set(out?.affectedModules)).toEqual(new Set(['/dep.ts', '/consumer.ts']))
			expect(out?.syncedModules).toEqual(['/consumer.ts'])
			expect(out?.autoDisabled).toEqual([])
			expect(host.ctx.registry.lastCommit?.runtimeUpdate.reason).toBe('hmr')
			expect(new Set(host.ctx.registry.lastCommit?.runtimeUpdate.affectedModules)).toEqual(
				new Set(['/dep.ts', '/consumer.ts']),
			)
			expect(moduleItemsSeenDuringHmrCommit).toEqual([DepNext])

			const nextConsumer = host.get(Consumer)
			expect(nextConsumer?.seq).toBe(2)
			expect(nextConsumer?.dep.seq).toBe(2)
			expect(nextConsumer).not.toBe(firstConsumer)
		} finally {
			await host.dispose()
		}
	})

	it('auto-disables missing-deps plugins and commits the rest', async () => {
		const host = createRuntimeHost()
		try {
			abstract class MissingBase extends BasePlugin {}

			class Broken extends BasePlugin {
				constructor(_dep: MissingBase) {
					super()
				}
			}
			defineParamTypes(Broken, [MissingBase])
			Plugin({ name: 'Broken' })(Broken)
			setParamToken(Broken, 0, MissingBase)

			enablePlugins(host.ctx, 'Broken')

			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					expect(id).toBe('/broken.ts')
					return { Broken }
				},
				config: {
					autoDisableMissingDependencies: true,
					autoDisableMaxPasses: 3,
				},
			})

			const out = await executor.runAndLoadAllClean(['/broken.ts'])
			expect(out?.commitResult.ok).toBe(true)
			expect(out?.affectedModules).toEqual([])
			expect(out?.syncedModules).toEqual(['/broken.ts'])
			expect(out?.autoDisabled).toEqual(['Broken'])
			expect(host.ctx.registry.lastCommit?.runtimeUpdate.autoDisabled).toEqual(['Broken'])
			expect(isEnabled(host.ctx, 'Broken')).toBe(false)
			expect(host.isRunning(Broken)).toBe(false)
		} finally {
			await host.dispose()
		}
	})

	it('stops the batch when a runner evaluation fails before commit retry', async () => {
		const host = createRuntimeHost()
		try {
			let stableSeq = 0

			class Stable extends BasePlugin {
				readonly seq = ++stableSeq
			}
			Plugin({ name: 'Stable' })(Stable)

			abstract class MissingBase extends BasePlugin {}

			class Broken extends BasePlugin {
				constructor(_dep: MissingBase) {
					super()
				}
			}
			defineParamTypes(Broken, [MissingBase])
			Plugin({ name: 'Broken' })(Broken)
			setParamToken(Broken, 0, MissingBase)

			enablePlugins(host.ctx, 'Stable', 'Broken')
			await host.ctx.loader.replaceModule('/stable.ts', { Stable })
			await host.commit()

			const firstStable = host.require(Stable)
			const executor = createExecutor(host.ctx, {
				importModule: async (id) => {
					if (id === '/stable.ts') throw new Error('syntax error')
					if (id === '/broken.ts') return { Broken }
					return {}
				},
				config: {
					autoDisableMissingDependencies: true,
					autoDisableMaxPasses: 3,
				},
			})

			const out = await executor.runAndLoadAllClean(['/stable.ts', '/broken.ts'])
			expect(out?.commitResult.ok).toBe(false)
			expect(out?.executeError).toBe('syntax error')
			expect(out?.syncedModules).toEqual([])
			expect(out?.autoDisabled).toEqual([])
			expect(host.ctx.registry.lastCommit?.runtimeUpdate.autoDisabled ?? []).toEqual([])
			expect(isEnabled(host.ctx, 'Broken')).toBe(true)
			expect(host.require(Stable)).toBe(firstStable)
		} finally {
			await host.dispose()
		}
	})
})

describe('collectEnabledButStopped', () => {
	it('reports enabled-but-stopped plugins within the batch-related module set', async () => {
		const findModuleIdByName = vi.fn((name: string) =>
			name === 'StoppedElsewhere' ? '/other.ts' : null,
		)
		const ctx: EnabledButStoppedLookupContext = {
			loader: {
				api: {
					registry: {
						findModuleIdByName,
					},
					status: {
						snapshot: () => ({
							statuses: {
								StoppedInBatch: { isEnabled: true, isRunning: false },
								StoppedElsewhere: { isEnabled: true, isRunning: false },
								RunningInBatch: { isEnabled: true, isRunning: true },
							},
						}),
					},
					anchors: {
						has: () => false,
						remove: () => {},
					},
				},
			},
			registry: {
				getRuntimeModuleId: (name: string) =>
					name === 'StoppedInBatch' ? '/consumer.ts' : undefined,
			},
		}

		const stopped = collectEnabledButStopped(ctx, new Set(['/consumer.ts']))
		expect(stopped).toEqual(['StoppedInBatch'])
		expect(findModuleIdByName).not.toHaveBeenCalledWith('StoppedInBatch')
	})
})
