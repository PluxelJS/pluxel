import type { RootContext, PluginNodeAddress } from '@pluxel/core'
import { RpcStub, type RpcTarget } from 'capnweb'
import { requireWorkbench } from './services/workbench'
import { openWorkbenchEntry, readWorkbenchLayout } from './workbench/client'
import {
	readWorkbenchOpenedContentHandle,
	readWorkbenchOpenedViewHandle,
	type WorkbenchOpenedContentHandle,
	type WorkbenchOpenedViewHandle,
} from './workbench/opened-entry'
import {
	readWorkbenchDescriptor,
	type WorkbenchContent,
	type WorkbenchContentSlotMap,
	type WorkbenchDescriptorApi,
	type WorkbenchDescriptorConsumerApi,
	type WorkbenchPrincipal,
} from './workbench/definition'
import type {
	WorkbenchContentPresentation,
	WorkbenchContentRef,
	WorkbenchContentRoot,
	WorkbenchFederatedViewRef,
} from './workbench/client-protocol'
import type { WorkbenchContentPlan } from '@pluxel/core/internal'

/** Existential input shape; exact authored descriptor brands are inferred by `open()`. */
export type WorkbenchOpenableEntry = Readonly<{
	kind: 'view' | 'attachment-placement' | 'content'
}>

export type LocalWorkbenchEntryOptions<Entry extends WorkbenchOpenableEntry> = Readonly<{
	target: PluginNodeAddress
	entry: Entry
	principal: WorkbenchPrincipal
	/** Optional route location parsed by the production Workbench route matcher. */
	location?: string
	/** Cancels waiting and releases the session; admitted domain work is not rolled back. */
	signal?: AbortSignal
}>

type OpenedLocalWorkbenchLease<Value extends object> = Readonly<Value> & Disposable

type OpenedWorkbenchViewValue<Api extends RpcTarget> = Readonly<{
	kind: 'view'
	api: RpcStub<Api>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedWorkbenchAttachmentValue<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never,
> = Readonly<{
	kind: 'attachment'
	provider: RpcStub<ProviderApi>
	consumer: [ConsumerApi] extends [never] ? undefined : RpcStub<ConsumerApi>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedWorkbenchContentBase = Readonly<{
	kind: 'content'
	params: Readonly<Record<string, string>>
	contentRef: WorkbenchContentRef
	plan: WorkbenchContentPlan
}>

type OpenedWorkbenchStaticContentValue = OpenedWorkbenchContentBase &
	Readonly<{
		mode: 'static'
	}>

type OpenedWorkbenchInteractiveContentValue = OpenedWorkbenchContentBase &
	Readonly<{
		mode: 'interactive'
		presentation: WorkbenchContentPresentation
		root: RpcStub<WorkbenchContentRoot>
	}>

type OpenedWorkbenchContentValue<Slots extends WorkbenchContentSlotMap> = keyof Slots extends never
	? OpenedWorkbenchStaticContentValue
	: OpenedWorkbenchInteractiveContentValue

export type OpenedLocalWorkbenchEntry<Entry extends WorkbenchOpenableEntry> =
	Entry extends Readonly<{ kind: 'view' }>
		? OpenedLocalWorkbenchLease<OpenedWorkbenchViewValue<WorkbenchDescriptorApi<Entry>>>
		: Entry extends Readonly<{ kind: 'attachment-placement' }>
			? OpenedLocalWorkbenchLease<
					OpenedWorkbenchAttachmentValue<
						WorkbenchDescriptorApi<Entry>,
						WorkbenchDescriptorConsumerApi<Entry>
					>
				>
			: Entry extends WorkbenchContent<infer Slots>
				? OpenedLocalWorkbenchLease<OpenedWorkbenchContentValue<Slots>>
				: never

/** Opens a published entry using a local session. The caller owns the returned disposable handle. */
export async function openLocalWorkbenchEntry<const Entry extends WorkbenchOpenableEntry>(
	ctx: RootContext,
	options: LocalWorkbenchEntryOptions<Entry>,
): Promise<OpenedLocalWorkbenchEntry<Entry>> {
	const { target, signal } = options
	signal?.throwIfAborted()
	const backend = requireWorkbench(ctx)
	const metadata = readWorkbenchDescriptor(options.entry)
	if (!backend.registry.hasPublishedEntry(target, options.entry)) {
		throw workbenchSetupError(
			target,
			metadata.key,
			'target_unavailable',
			'target is not running or did not publish this exact authored entry',
		)
	}
	const session = backend.createSession(options.principal, () => undefined)
	const rpc = new RpcStub(session.target)
	let handle: WorkbenchOpenedViewHandle | WorkbenchOpenedContentHandle | undefined
	let disposed = false
	let cleanupFailed = false
	let cleanupFailure: unknown
	const dispose = () => {
		if (disposed) {
			if (cleanupFailed) throw cleanupFailure
			return
		}
		disposed = true
		signal?.removeEventListener('abort', onAbort)
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
		try {
			throwCollected(errors, 'Local Workbench entry cleanup failed')
		} catch (error) {
			cleanupFailed = true
			cleanupFailure = error
			throw error
		}
	}
	let rejectAbort: (reason: unknown) => void = () => undefined
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject
	})
	const onAbort = () => {
		try {
			dispose()
		} catch (error) {
			rejectAbort(
				new AggregateError([signal?.reason, error], 'Workbench entry cancellation cleanup failed'),
			)
			return
		}
		rejectAbort(signal?.reason)
	}
	signal?.addEventListener('abort', onAbort, { once: true })
	// Observe cancellation even after open has returned; ownership remains attached to the signal.
	void aborted.catch((): undefined => undefined)
	try {
		const pending = (async () => {
			const layout = await readWorkbenchLayout(rpc, { target })
			signal?.throwIfAborted()
			const entry = layout.entries.find(
				(candidate) =>
					candidate.descriptor.kind === metadata.kind && candidate.descriptor.key === metadata.key,
			)
			if (!entry)
				throw workbenchSetupError(
					target,
					metadata.key,
					'target_unavailable',
					'entry is absent from the current target layout',
				)
			const opened = await openWorkbenchEntry(rpc, entry, {
				layoutRevision: layout.revision,
				...(options.location === undefined ? {} : { location: options.location }),
			})
			if (opened.ok === false)
				throw workbenchSetupError(
					target,
					metadata.key,
					opened.code,
					'openEntry rejected the request',
				)
			if (disposed) {
				opened.handle[Symbol.dispose]()
				signal?.throwIfAborted()
				throw new Error('Workbench session closed while opening entry')
			}
			handle = opened.handle
			const value =
				handle.kind === 'content'
					? contentLeaseValue(handle)
					: viewLeaseValue(handle, metadata.kind)
			return Object.freeze({
				...value,
				[Symbol.dispose]: dispose,
			}) as OpenedLocalWorkbenchEntry<Entry>
		})()
		return await Promise.race([pending, aborted])
	} catch (error) {
		try {
			dispose()
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], 'Workbench entry open and cleanup failed', {
				cause: cleanupError,
			})
		}
		throw error
	}
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
		`[pluxel/workbench] Workbench opened kind ${value.kind} does not match authored ${expectedKind}`,
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

function workbenchSetupError(
	target: PluginNodeAddress,
	entry: string,
	code: string,
	detail: string,
): Error {
	return Object.assign(
		new Error(
			`[pluxel/workbench] openLocalWorkbenchEntry(${target.definition.exportName}.${entry}) failed (${code}): ${detail}`,
		),
		{ code },
	)
}

function throwCollected(errors: readonly unknown[], message: string): void {
	if (errors.length === 0) return
	if (errors.length === 1) throw errors[0]
	throw new AggregateError(errors, message)
}
