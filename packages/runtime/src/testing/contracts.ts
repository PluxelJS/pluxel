import type { CommandContext, CommandDescriptor } from '@pluxel/commands'
import type {
	PluginForkRef,
	PluginTestTarget,
	RawPluginConfig,
} from '@pluxel/core/test'
import type { RpcStub, RpcTarget } from '../capnweb'
import type { PluginConfigResult } from '../api/usecases/pluginConfig'
import type {
	WorkbenchContent,
	WorkbenchContentSlotMap,
	WorkbenchDescriptorApi,
	WorkbenchDescriptorConsumerApi,
	WorkbenchPrincipal,
} from '../workbench/definition'
import type {
	WorkbenchContentPresentation,
	WorkbenchContentRef,
	WorkbenchContentRoot,
	WorkbenchFederatedViewRef,
} from '../workbench/client-protocol'
import type { WorkbenchContentPlan } from '@pluxel/core/internal'

export interface RuntimeConfigTestDriver<
	TTarget extends PluginTestTarget = PluginTestTarget,
> {
	/**
	 * Applies a shallow raw-config patch through the production persistence and running-generation
	 * notification path. Fixture bootstrap config belongs on `host.start()` instead.
	 */
	patch(target: TTarget, patch: RawPluginConfig): Promise<PluginConfigResult>
}

export interface RuntimeHttpTestDriver {
	/** Logical in-process origin. It is not backed by a listening socket. */
	readonly origin: 'http://local.test'
	/** Dispatches through the production immutable Runtime HTTP directory. */
	fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>
}

export interface RuntimeCommandsTestDriver {
	/** Executes the currently published command through the production command registry. */
	execute(name: string, input: unknown, context?: CommandContext): Promise<unknown>
	/** Returns the production registry's current immutable descriptor list. */
	list(): readonly CommandDescriptor[]
}

/** Existential input shape; exact authored descriptor brands are inferred by `open()`. */
export type WorkbenchTestOpenableEntry = Readonly<{
	kind: 'view' | 'attachment-placement' | 'content'
}>

export type WorkbenchTestOpenOptions<
	Entry extends WorkbenchTestOpenableEntry,
	TTarget extends PluginTestTarget = PluginTestTarget,
> = Readonly<{
	target: TTarget
	entry: Entry
	principal: WorkbenchPrincipal
	/** Optional route location parsed by the production Workbench route matcher. */
	location?: string
}>

export type OpenedWorkbenchTestLease<Value extends object> = Readonly<Value> & Disposable

type OpenedWorkbenchViewTestValue<Api extends RpcTarget> = Readonly<{
	kind: 'view'
	api: RpcStub<Api>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedWorkbenchAttachmentTestValue<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never,
> = Readonly<{
	kind: 'attachment'
	provider: RpcStub<ProviderApi>
	consumer: [ConsumerApi] extends [never] ? undefined : RpcStub<ConsumerApi>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedWorkbenchContentTestBase = Readonly<{
	kind: 'content'
	params: Readonly<Record<string, string>>
	contentRef: WorkbenchContentRef
	plan: WorkbenchContentPlan
}>

type OpenedWorkbenchStaticContentTestValue = OpenedWorkbenchContentTestBase &
	Readonly<{
		mode: 'static'
	}>

type OpenedWorkbenchInteractiveContentTestValue = OpenedWorkbenchContentTestBase &
	Readonly<{
		mode: 'interactive'
		presentation: WorkbenchContentPresentation
		root: RpcStub<WorkbenchContentRoot>
	}>

type OpenedWorkbenchContentTestValue<Slots extends WorkbenchContentSlotMap> =
	keyof Slots extends never
		? OpenedWorkbenchStaticContentTestValue
		: OpenedWorkbenchInteractiveContentTestValue

export type OpenedWorkbenchTestEntry<Entry extends WorkbenchTestOpenableEntry> =
	Entry extends Readonly<{ kind: 'view' }>
		? OpenedWorkbenchTestLease<
				OpenedWorkbenchViewTestValue<WorkbenchDescriptorApi<Entry>>
			>
		: Entry extends Readonly<{ kind: 'attachment-placement' }>
			? OpenedWorkbenchTestLease<
					OpenedWorkbenchAttachmentTestValue<
						WorkbenchDescriptorApi<Entry>,
						WorkbenchDescriptorConsumerApi<Entry>
					>
				>
			: Entry extends WorkbenchContent<infer Slots>
				? OpenedWorkbenchTestLease<OpenedWorkbenchContentTestValue<Slots>>
				: never

export interface RuntimeWorkbenchTestDriver<
	TTarget extends PluginTestTarget = PluginTestTarget,
> {
	/** Opens an active authored entry through a real local Cap'n Web Workbench session. */
	open<const Entry extends WorkbenchTestOpenableEntry>(
		options: WorkbenchTestOpenOptions<Entry, TTarget>,
	): Promise<OpenedWorkbenchTestEntry<Entry>>
}

/** A target type accepted by a catalog-constrained host, including declared forks. */
export type RuntimeStaticPluginTestTarget<TPlugin extends import('@pluxel/core').PluginConstructor> =
	| TPlugin
	| PluginForkRef<TPlugin>
