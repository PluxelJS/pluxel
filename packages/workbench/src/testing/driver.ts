import type { RootContext, PluginNodeAddress } from '@pluxel/core'
import { PluginTestOperationGate, type PluginTestTarget } from '@pluxel/core/internal/test'
import {
	openLocalWorkbenchEntry,
	type OpenedLocalWorkbenchEntry,
	type WorkbenchOpenableEntry,
} from '../local-entry'
import { readWorkbenchDescriptor } from '../workbench/definition'
import type { WorkbenchTestDriver, WorkbenchTestOpenOptions } from './contracts'

export function createWorkbenchTestDriver({
	ctx,
	resolveTarget,
}: {
	ctx: RootContext
	resolveTarget(target: PluginTestTarget): PluginNodeAddress
}) {
	const gate = new PluginTestOperationGate()
	const leases = new Map<Disposable, string>()
	const pending = new Set<AbortController>()
	const workbench: WorkbenchTestDriver = Object.freeze({
		async open<const Entry extends WorkbenchOpenableEntry>(
			options: WorkbenchTestOpenOptions<Entry>,
		) {
			gate.assertAccepting('workbench.open')
			const controller = new AbortController()
			pending.add(controller)
			const signal = options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			try {
				const target = resolveTarget(options.target)
				const opened = await openLocalWorkbenchEntry(ctx, { ...options, target, signal })
				let lease!: OpenedLocalWorkbenchEntry<Entry>
				const dispose = () => {
					signal.removeEventListener('abort', onAbort)
					leases.delete(lease)
					opened[Symbol.dispose]()
				}
				const onAbort = () => {
					try {
						opened[Symbol.dispose]()
						leases.delete(lease)
					} catch {
						// Retain failed cleanup so host teardown reports it; event listeners must not throw.
					}
				}
				signal.addEventListener('abort', onAbort, { once: true })
				try {
					signal.throwIfAborted()
					gate.assertAccepting('workbench.open result')
					resolveTarget(options.target)
				} catch (error) {
					dispose()
					throw error
				}
				const metadata = readWorkbenchDescriptor(options.entry)
				const stack = new Error('Workbench entry created').stack
				lease = Object.freeze({
					...opened,
					[Symbol.dispose]: dispose,
				}) as unknown as OpenedLocalWorkbenchEntry<Entry>
				leases.set(
					lease,
					`${metadata.kind}:${metadata.key} for ${JSON.stringify(target)}\n${stack ?? ''}`,
				)
				return lease
			} finally {
				pending.delete(controller)
			}
		},
	})
	const dispose = () =>
		gate.dispose(async () => {
			for (const controller of pending) controller.abort(new Error('Workbench test host disposed'))
			const errors: unknown[] = []
			for (const [lease, label] of [...leases].toReversed()) {
				errors.push(new Error(`[pluxel/test] Leaked Workbench entry ${label}`))
				try {
					lease[Symbol.dispose]()
				} catch (error) {
					errors.push(error)
				}
			}
			leases.clear()
			if (errors.length > 0)
				throw new AggregateError(errors, 'Workbench test driver cleanup failed')
		})
	return { workbench, dispose }
}
