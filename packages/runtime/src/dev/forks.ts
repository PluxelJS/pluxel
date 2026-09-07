import type { PluginNodeAddress, RootContext } from '@pluxel/core'
import { ensureFork, removeFork } from '../api/usecases/pluginForks'
import { projectPluginApplyReport } from '../api/presenters/pluginApplyReport'
import type { DevConsole, DevPluginTarget, DevPluginForkTarget } from './contracts'
import type { DevScope } from './scope'

export function createDevForks(
	ctx: RootContext,
	scope: DevScope,
	resolveTarget: (target: DevPluginTarget) => PluginNodeAddress,
): DevConsole['forks'] {
	const resolveFork = (target: DevPluginForkTarget) => {
		const node = resolveTarget(target)
		if (node.variant !== 'fork') throw new TypeError('Expected a fork target')
		return {
			base: { definition: node.definition, variant: 'default' as const },
			forkId: node.forkId,
		}
	}
	return Object.freeze({
		ensure: (target: DevPluginForkTarget) =>
			scope.run(async () => {
				const { base, forkId } = resolveFork(target)
				const result = await ensureFork(ctx, base, forkId)
				if (result.ok === true)
					return {
						ok: true as const,
						status: result.status,
						fork: result.node,
						report: projectPluginApplyReport(ctx, result.report),
					}
				if (result.code === 'persistence_failed')
					return {
						ok: false as const,
						code: result.code,
						state: result.state,
						error: result.message,
					}
				return { ok: false as const, code: result.code, state: result.state, error: result.message }
			}),
		remove: (target: DevPluginForkTarget) =>
			scope.run(async () => {
				const { base, forkId } = resolveFork(target)
				const result = await removeFork(ctx, base, forkId)
				if (result.ok === true) {
					if (result.status === 'already-absent')
						return {
							ok: true as const,
							status: result.status,
							fork: result.node,
						}
					return {
						ok: true as const,
						status: result.status,
						fork: result.node,
						report: projectPluginApplyReport(ctx, result.report),
					}
				}
				if (result.code === 'fork_referenced')
					return {
						ok: false as const,
						code: result.code,
						state: result.state,
						references: result.references,
						error: result.message,
					}
				if (result.code === 'persistence_failed')
					return {
						ok: false as const,
						code: result.code,
						state: result.state,
						fork: result.node,
						...(result.report ? { report: projectPluginApplyReport(ctx, result.report) } : {}),
						error: result.message,
					}
				return { ok: false as const, code: result.code, state: result.state, error: result.message }
			}),
	})
}
