import type { PluginNodeAddress, RootContext } from '@pluxel/core'
import { RpcStub } from 'capnweb'
import { requireWorkbench } from '../services/workbench'
import { openWorkbenchEntry, readWorkbenchLayout } from '../workbench/client'
import {
	readWorkbenchOpenedContentHandle,
	readWorkbenchOpenedViewHandle,
	type WorkbenchOpenedContentHandle,
	type WorkbenchOpenedViewHandle,
} from '../workbench/opened-entry'
import { readWorkbenchDescriptor } from '../workbench/definition'
import type {
	DevConsole,
	DevPluginTarget,
	WorkbenchDevOpenableEntry,
	WorkbenchDevOpenOptions,
	OpenedWorkbenchDevEntry,
} from './contracts'
import type { DevScope } from './scope'

export function createDevWorkbench(
	ctx: RootContext,
	scope: DevScope,
	resolveTarget: (target: DevPluginTarget) => PluginNodeAddress,
): DevConsole['workbench'] {
	const sessionFor = (principal: import('../workbench/definition').WorkbenchPrincipal) => {
		const session = requireWorkbench(ctx).createSession(principal, () => undefined)
		const rpc = new RpcStub(session.target)
		let handle: WorkbenchOpenedViewHandle | WorkbenchOpenedContentHandle | undefined
		const release = scope.own(() => {
			const errors: unknown[] = []
			for (const cleanup of [
				() => handle?.[Symbol.dispose](),
				() => rpc[Symbol.dispose](),
				() => session.dispose(),
			]) {
				try {
					cleanup()
				} catch (error) {
					errors.push(error)
				}
			}
			if (errors.length > 0)
				throw new AggregateError(errors, 'Workbench development lease cleanup failed')
		})
		return {
			rpc,
			release,
			setHandle(value: WorkbenchOpenedViewHandle | WorkbenchOpenedContentHandle) {
				handle = value
				if (scope.controller.signal.aborted) value[Symbol.dispose]()
			},
		}
	}
	return Object.freeze({
		list: (options) =>
			scope.run(async () => {
				const target = resolveTarget(options.target)
				const session = sessionFor(options.principal)
				let layout
				try {
					layout = await readWorkbenchLayout(session.rpc, { target })
				} catch (error) {
					closeAfterFailure(session.release, error)
				}
				session.release()
				return layout!
			}),
		open<const Entry extends WorkbenchDevOpenableEntry>(
			options: WorkbenchDevOpenOptions<Entry>,
		): Promise<OpenedWorkbenchDevEntry<Entry>> {
			return scope.run(async () => {
				const target = resolveTarget(options.target)
				const metadata = readWorkbenchDescriptor(options.entry)
				if (!requireWorkbench(ctx).registry.hasPublishedEntry(target, options.entry)) {
					throw Object.assign(
						new Error(
							'Target is not running or did not publish this exact authored Workbench entry',
						),
						{ code: 'target_unavailable' },
					)
				}
				const session = sessionFor(options.principal)
				try {
					const layout = await readWorkbenchLayout(session.rpc, { target })
					const entry = layout.entries.find(
						(item) =>
							item.descriptor.kind === metadata.kind && item.descriptor.key === metadata.key,
					)
					if (!entry)
						throw Object.assign(new Error('Entry is absent from the current target layout'), {
							code: 'target_unavailable',
						})
					const opened = await openWorkbenchEntry(session.rpc, entry, {
						layoutRevision: layout.revision,
						...(options.location === undefined ? {} : { location: options.location }),
					})
					if (opened.ok === false)
						throw Object.assign(new Error(`Workbench open failed: ${opened.code}`), {
							code: opened.code,
						})
					session.setHandle(opened.handle)
					scope.assertOpen()
					const value =
						opened.handle.kind === 'content'
							? contentLeaseValue(opened.handle)
							: viewLeaseValue(opened.handle, metadata.kind)
					return Object.freeze({ ...value, [Symbol.dispose]: session.release }) as never
				} catch (error) {
					return closeAfterFailure(session.release, error)
				}
			})
		},
	})
}
function viewLeaseValue(handle: WorkbenchOpenedViewHandle, expectedKind: string) {
	const value = readWorkbenchOpenedViewHandle(handle)
	if (expectedKind === 'view' && value.kind === 'local') {
		return {
			kind: 'view' as const,
			api: value.api,
			params: value.params,
			federatedViewRef: value.federatedViewRef,
		}
	}
	if (expectedKind === 'attachment-placement' && value.kind === 'attachment') {
		return {
			kind: 'attachment' as const,
			provider: value.provider,
			consumer: value.consumer,
			params: value.params,
			federatedViewRef: value.federatedViewRef,
		}
	}
	throw new Error(
		`[pluxel/dev] Workbench opened kind ${value.kind} does not match authored ${expectedKind}`,
	)
}

function contentLeaseValue(handle: WorkbenchOpenedContentHandle) {
	const value = readWorkbenchOpenedContentHandle(handle)
	return value.mode === 'static'
		? {
				kind: 'content' as const,
				mode: 'static' as const,
				params: value.params,
				contentRef: value.contentRef,
				plan: value.plan,
			}
		: {
				kind: 'content' as const,
				mode: 'interactive' as const,
				params: value.params,
				contentRef: value.contentRef,
				plan: value.plan,
				presentation: value.presentation,
				root: value.root,
			}
}

function closeAfterFailure(release: () => void, failure: unknown): never {
	try {
		release()
	} catch (cleanup) {
		throw new AggregateError([failure, cleanup], 'Workbench operation and cleanup failed', {
			cause: cleanup,
		})
	}
	throw failure
}
