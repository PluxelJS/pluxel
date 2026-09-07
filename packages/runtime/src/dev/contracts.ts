import type {
	PluginConstructor,
	PluginNodeAddress,
	PluginDefinitionAddress,
	PluginToken,
} from '@pluxel/core'
import type { CommandContext, CommandDescriptor } from '@pluxel/commands'
import type { RpcStub, RpcTarget } from '../capnweb'
import type { WorkbenchContentPlan } from '@pluxel/core/internal'
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
	WorkbenchLayout,
} from '../workbench/client-protocol'
import type {
	ConfigResult,
	ConfigPresentationResult,
	PluginControlMutationResult,
	PluginStatusSnapshot,
	PluginConsumerRequirementsInspectionResult,
	PluginDependencyMutationResult,
	EnsureForkResult,
	RemoveForkResult,
} from '../web/protocol'
import type { LogFilter, LogRangeErr, LogStreamMeta, RuntimeLogLine } from '../logger/protocol'

/** Current concrete implementation; fork references do not create a fork. */
export type DevTypedPluginTarget<P extends PluginConstructor = PluginConstructor> =
	| P
	| Readonly<{ plugin: P; forkId: string }>
/** Requirement identity; abstract tokens identify a contract, never a running node. */
export type DevPluginRequirement = PluginToken | PluginDefinitionAddress
export type DevDependencyOverrideTarget = Readonly<{
	consumer: DevPluginTarget
	requirement: DevPluginRequirement
}>
export type DevProviderDefaultInput = Readonly<{
	requirement: DevPluginRequirement
	provider: PluginConstructor | Extract<PluginNodeAddress, { variant: 'default' }>
}>
export type DevPluginForkTarget =
	| Readonly<{ plugin: PluginConstructor; forkId: string }>
	| Extract<PluginNodeAddress, { variant: 'fork' }>
export type DevPluginTarget = DevTypedPluginTarget | PluginNodeAddress
export type DevPluginInstance<T extends DevTypedPluginTarget> = T extends PluginConstructor
	? InstanceType<T>
	: T extends { plugin: infer P extends PluginConstructor }
		? InstanceType<P>
		: never
export type DevRunContext = Readonly<{ id: string; input: unknown; signal: AbortSignal }>
export type DevScript = (dev: DevConsole, run: DevRunContext) => unknown | Promise<unknown>

export class DevConsoleError extends Error {
	constructor(
		readonly code:
			| 'scope_closed'
			| 'target_unavailable'
			| 'stale_target'
			| 'plugin_not_running'
			| 'logs_unavailable',
		message: string,
	) {
		super(message)
		this.name = 'DevConsoleError'
	}
}

export type DevLogCursor = Readonly<{
	rootId: string
	bootId: string
	streamId: string
	epoch: number
	nextSeq: string
}>
export type DevLogReadOptions = Readonly<{
	cursor: DevLogCursor
	target?: DevPluginTarget
	filter?: LogFilter
	/** Maximum scanned records, default 200, at most 2000. */ limit?: number
}>
export type DevLogReadResult =
	| Readonly<{ ok: true; lines: readonly RuntimeLogLine[]; cursor: DevLogCursor; hasMore: boolean }>
	| (LogRangeErr & Readonly<{ cursor: DevLogCursor }>)
	| Readonly<{ ok: false; code: 'root_changed'; cursor: DevLogCursor }>
export type DevLogWaitResult = Readonly<{
	reason: 'available' | 'more' | 'timeout' | 'reset'
	result: DevLogReadResult
}>

export interface DevConsole {
	readonly plugins: {
		list(): Promise<readonly PluginStatusSnapshot[]>
		isRunning(target: DevPluginTarget): boolean
		status(target: DevPluginTarget): Promise<PluginStatusSnapshot | null>
		start(target: DevPluginTarget): Promise<PluginControlMutationResult>
		stop(target: DevPluginTarget): Promise<PluginControlMutationResult>
		restart(target: DevPluginTarget): Promise<PluginControlMutationResult>
		/** Real current object, not a revocable proxy; reacquire after HMR or restart. */
		require<T extends DevTypedPluginTarget>(target: T): DevPluginInstance<T>
	}
	readonly forks: {
		/** Ensure durable identity without starting it or changing existing auto-start policy. */
		ensure(target: DevPluginForkTarget): Promise<EnsureForkResult>
		remove(target: DevPluginForkTarget): Promise<RemoveForkResult>
	}
	readonly dependencies: {
		/** Current required edges, saved selection, inherited provider, and available options. */
		inspect(consumer: DevPluginTarget): Promise<PluginConsumerRequirementsInspectionResult>
		setDefault(input: DevProviderDefaultInput): Promise<PluginDependencyMutationResult>
		clearDefault(requirement: DevPluginRequirement): Promise<PluginDependencyMutationResult>
		setOverride(
			input: DevDependencyOverrideTarget & Readonly<{ provider: DevPluginTarget }>,
		): Promise<PluginDependencyMutationResult>
		clearOverride(input: DevDependencyOverrideTarget): Promise<PluginDependencyMutationResult>
	}
	readonly config: {
		/** Saved raw values, defaults, and desired/applied revisions. */
		get(target: DevPluginTarget): Promise<ConfigResult>
		/** Portable schema presentation including field paths, constraints, and defaults. */
		describe(target: DevPluginTarget): Promise<ConfigPresentationResult>
		/** Validate a shallow patch without saving it. */
		validate(
			target: DevPluginTarget,
			patch: Readonly<Record<string, unknown>>,
		): Promise<ConfigResult>
		patch(target: DevPluginTarget, patch: Readonly<Record<string, unknown>>): Promise<ConfigResult>
		/** Existing config field-path grammar, as returned by describe(). */
		patchField(
			target: DevPluginTarget,
			input: Readonly<{ fieldPath: string; value: unknown }>,
		): Promise<ConfigResult>
		/** Omitted or empty keys resets every saved top-level field. */
		reset(target: DevPluginTarget, keys?: readonly string[]): Promise<ConfigResult>
	}
	readonly commands: {
		list(): readonly CommandDescriptor[]
		execute(name: string, input: unknown, context?: CommandContext): Promise<unknown>
	}
	readonly http: {
		/** Logical in-process origin, without a listening socket. */
		readonly origin: string
		fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>
	}
	readonly workbench: {
		list(
			options: Readonly<{ target: DevPluginTarget; principal: WorkbenchPrincipal }>,
		): Promise<WorkbenchLayout>
		open<const Entry extends WorkbenchDevOpenableEntry>(
			options: WorkbenchDevOpenOptions<Entry>,
		): Promise<OpenedWorkbenchDevEntry<Entry>>
	}
	readonly logs: {
		/** Flush the current store buffers before taking a cursor. Default stream is default. */
		mark(options?: Readonly<{ streamId?: string }>): Promise<DevLogCursor>
		/** Bounded recent window; it does not prove the absence of older matching logs. */
		tail(
			options?: Readonly<{
				streamId?: string
				target?: DevPluginTarget
				filter?: LogFilter
				limit?: number
			}>,
		): Promise<
			Readonly<{ meta: LogStreamMeta; lines: readonly RuntimeLogLine[]; cursor: DevLogCursor }>
		>
		read(options: DevLogReadOptions): Promise<DevLogReadResult>
		/** Wait at most 5 seconds by default, maximum 30 seconds; run cancellation rejects. */
		wait(
			options: DevLogReadOptions & Readonly<{ timeoutMs?: number; signal?: AbortSignal }>,
		): Promise<DevLogWaitResult>
	}
}

/** Existential input shape; exact authored descriptor brands are inferred by `open()`. */
export type WorkbenchDevOpenableEntry = Readonly<{
	kind: 'view' | 'attachment-placement' | 'content'
}>

export type WorkbenchDevOpenOptions<
	Entry extends WorkbenchDevOpenableEntry,
	TTarget extends DevPluginTarget = DevPluginTarget,
> = Readonly<{
	target: TTarget
	entry: Entry
	principal: WorkbenchPrincipal
	/** Optional route location parsed by the production Workbench route matcher. */
	location?: string
}>

export type OpenedWorkbenchDevLease<Value extends object> = Readonly<Value> & Disposable

type OpenedWorkbenchViewDevValue<Api extends RpcTarget> = Readonly<{
	kind: 'view'
	api: RpcStub<Api>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedWorkbenchAttachmentDevValue<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never,
> = Readonly<{
	kind: 'attachment'
	provider: RpcStub<ProviderApi>
	consumer: [ConsumerApi] extends [never] ? undefined : RpcStub<ConsumerApi>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedWorkbenchContentDevBase = Readonly<{
	kind: 'content'
	params: Readonly<Record<string, string>>
	contentRef: WorkbenchContentRef
	plan: WorkbenchContentPlan
}>

type OpenedWorkbenchStaticContentDevValue = OpenedWorkbenchContentDevBase &
	Readonly<{
		mode: 'static'
	}>

type OpenedWorkbenchInteractiveContentDevValue = OpenedWorkbenchContentDevBase &
	Readonly<{
		mode: 'interactive'
		presentation: WorkbenchContentPresentation
		root: RpcStub<WorkbenchContentRoot>
	}>

type OpenedWorkbenchContentDevValue<Slots extends WorkbenchContentSlotMap> =
	keyof Slots extends never
		? OpenedWorkbenchStaticContentDevValue
		: OpenedWorkbenchInteractiveContentDevValue

export type OpenedWorkbenchDevEntry<Entry extends WorkbenchDevOpenableEntry> =
	Entry extends Readonly<{ kind: 'view' }>
		? OpenedWorkbenchDevLease<OpenedWorkbenchViewDevValue<WorkbenchDescriptorApi<Entry>>>
		: Entry extends Readonly<{ kind: 'attachment-placement' }>
			? OpenedWorkbenchDevLease<
					OpenedWorkbenchAttachmentDevValue<
						WorkbenchDescriptorApi<Entry>,
						WorkbenchDescriptorConsumerApi<Entry>
					>
				>
			: Entry extends WorkbenchContent<infer Slots>
				? OpenedWorkbenchDevLease<OpenedWorkbenchContentDevValue<Slots>>
				: never
