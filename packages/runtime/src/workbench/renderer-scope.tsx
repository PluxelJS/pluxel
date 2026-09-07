import {
	CancelledError,
	QueryClient,
	QueryObserver,
	isCancelledError,
	type QueryFunctionContext,
	type QueryObserverResult,
} from '@tanstack/query-core'
import {
	createContext,
	createElement,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ComponentType,
	type ReactNode,
} from 'react'
import {
	detachWorkbenchPortableValue,
	WorkbenchPortableValueError,
	type WorkbenchDetached,
} from './client'
import { readWorkbenchDescriptor, type WorkbenchRenderableDescriptor } from './definition'
import type { WorkbenchResolvedPortableValue } from './portable-value'
import {
	resolveWorkbenchHookValue,
	useWorkbenchReactRuntime,
	type WorkbenchHookValue,
} from './react-context'

const MAX_KEY_DEPTH = 16
const MAX_KEY_NODES = 512
const MAX_KEY_TEXT = 16_384
const MAX_KEY_ARRAY_ITEMS = 128
const MAX_KEY_OBJECT_FIELDS = 128
const MAX_QUERY_ENTRIES = 256
const MAX_ACTIVE_QUERY_ENTRIES = 64
const MAX_MUTATION_INVALIDATIONS = 128
const QUERY_GC_TIME = 5 * 60_000

export type WorkbenchZeroProps = Readonly<Record<string, never>>

export type WorkbenchResourceKey =
	| null
	| boolean
	| number
	| string
	| readonly WorkbenchResourceKey[]
	| { readonly [key: string]: WorkbenchResourceKey }

export type WorkbenchQueryExecutionContext<
	QueryKey extends readonly WorkbenchResourceKey[] = readonly WorkbenchResourceKey[],
> = Readonly<Pick<QueryFunctionContext<QueryKey>, 'queryKey' | 'signal'>>

export type WorkbenchQueryRetry =
	| boolean
	| number
	| ((failureCount: number, error: unknown) => boolean)

export type WorkbenchQueryRetryDelay = number | ((failureCount: number, error: unknown) => number)

type WorkbenchAwaitable<Value> = Value | PromiseLike<NoInfer<Value>>
type WorkbenchResolvedResult<Value> = WorkbenchResolvedPortableValue<Value>
type WorkbenchQueryFunctionResult<Options> =
	Options extends Readonly<{
		queryFn: (...input: never[]) => infer Result
	}>
		? Result
		: never

export type WorkbenchQueryOptions<
	QueryKey extends readonly WorkbenchResourceKey[],
	Value,
> = Readonly<{
	queryKey: QueryKey
	queryFn(context: WorkbenchQueryExecutionContext<QueryKey>): WorkbenchAwaitable<Value>
	/** Whether this observer automatically reads and owns its subscription. @defaultValue true */
	enabled?: boolean
	/** Milliseconds before cached data becomes stale. Defaults to `0`, or `Infinity` with subscribe. */
	staleTime?: number
	/** TanStack-compatible retry behavior. Workbench boundary failures are never retried. @defaultValue false */
	retry?: WorkbenchQueryRetry
	retryDelay?: WorkbenchQueryRetryDelay
	/** Workbench extensions must be declared under `workbench`. */
	watch?: never
	/** Query resources do not declare mutation invalidations. */
	invalidates?: never
	workbench?: Readonly<{
		subscribe(context: WorkbenchQuerySubscriptionContext): Disposable | PromiseLike<Disposable>
	}>
}>

export type WorkbenchQuerySubscriptionContext = Readonly<{
	signal: AbortSignal
	invalidate(): void
}>

type WorkbenchExactOptions<Actual, Expected> = Actual extends Expected
	? Exclude<keyof Actual, keyof Expected> extends never
		? 'workbench' extends keyof Actual
			? Actual extends Readonly<{ workbench?: infer ActualWorkbench }>
				? Expected extends Readonly<{ workbench?: infer ExpectedWorkbench }>
					? Exclude<
							keyof NonNullable<ActualWorkbench>,
							keyof NonNullable<ExpectedWorkbench>
						> extends never
						? Actual
						: never
					: never
				: never
			: Actual
		: never
	: never

type WorkbenchExactOptionsConstraint<Actual, Expected> = [Actual] extends [
	WorkbenchExactOptions<Actual, Expected>,
]
	? unknown
	: never

type WorkbenchQueryControls<Value> = Readonly<{
	isFetching: boolean
	isStale: boolean
	refetch(): Promise<Value>
	invalidate(): void
}>

export type WorkbenchQueryResult<Value> = WorkbenchQueryControls<Value> &
	(
		| Readonly<{
				status: 'pending'
				data: undefined
				error: null
				isPending: true
				isStale: true
		  }>
		| Readonly<{
				status: 'success'
				data: Value
				error: null
				isPending: false
		  }>
		| Readonly<{
				status: 'error'
				data: Value | undefined
				error: unknown
				isPending: false
				isStale: true
		  }>
	)

declare const workbenchQueryInvalidation: unique symbol

export type WorkbenchQueryInvalidation<Descriptor> = Readonly<{
	readonly [workbenchQueryInvalidation]: Descriptor
}>

export interface WorkbenchQueryResource<
	Descriptor,
	Value,
> extends WorkbenchQueryInvalidation<Descriptor> {
	useQuery(): WorkbenchQueryResult<WorkbenchDetached<Value>>
}

export interface WorkbenchQueryFamilyResource<Descriptor, Input, Value> {
	useQuery(input: Input): WorkbenchQueryResult<WorkbenchDetached<Value>>
	target(input: Input): WorkbenchQueryInvalidation<Descriptor>
	all(): WorkbenchQueryInvalidation<Descriptor>
}

export type WorkbenchMutationExecutionContext<Context> = Context &
	Readonly<{
		/** Aborted when this per-open renderer owner closes. */
		signal: AbortSignal
	}>

export type WorkbenchMutationOptions<Descriptor, Input, Result> = Readonly<{
	mutationFn(input: Input): WorkbenchAwaitable<Result>
	/** Workbench extensions must be declared under `workbench`. */
	watch?: never
	/** Workbench extensions must be declared under `workbench`. */
	invalidates?: never
	workbench?: Readonly<{
		invalidates?:
			| readonly WorkbenchQueryInvalidation<Descriptor>[]
			| ((input: NoInfer<Input>) => readonly WorkbenchQueryInvalidation<Descriptor>[])
	}>
}>

type WorkbenchMutationFunctionInput<MutationFn> = MutationFn extends (...input: any[]) => any
	? Parameters<MutationFn> extends []
		? void
		: Parameters<MutationFn>[0]
	: never
type WorkbenchMutationFunctionResult<MutationFn> = MutationFn extends (
	...input: any[]
) => infer Result
	? Result
	: never
// `never` keeps an unannotated input-derived invalidation from silently widening to `any`.
// `Options` below separately captures the author's exact mutation function for Hook input/result types.
type WorkbenchMutationFunction = (input: never) => unknown
type WorkbenchInferredMutationOptions<
	Descriptor,
	MutationFn extends WorkbenchMutationFunction,
> = Readonly<{
	mutationFn: MutationFn
	/** Workbench extensions must be declared under `workbench`. */
	watch?: never
	/** Workbench extensions must be declared under `workbench`. */
	invalidates?: never
	workbench?: Readonly<{
		invalidates?:
			| readonly WorkbenchQueryInvalidation<Descriptor>[]
			| ((
					input: NoInfer<WorkbenchMutationFunctionInput<MutationFn>>,
			  ) => readonly WorkbenchQueryInvalidation<Descriptor>[])
	}>
}>

type WorkbenchDetachedResolvedMutationResult<Result> = Result extends void
	? void
	: WorkbenchDetached<Result>

type MutationArguments<Input> = [Input] extends [void] ? [] : [input: Input]

type WorkbenchMutationControls<Input, Result> = Readonly<{
	mutate(...input: MutationArguments<Input>): void
	mutateAsync(...input: MutationArguments<Input>): Promise<Result>
	/** Clears settled state. It neither cancels nor resets a pending operation. */
	reset(): void
}>

export type WorkbenchMutationState<Input, Result> = WorkbenchMutationControls<Input, Result> &
	(
		| Readonly<{
				status: 'idle'
				isPending: false
				data: undefined
				error: null
		  }>
		| Readonly<{
				status: 'pending'
				isPending: true
				data: undefined
				error: null
		  }>
		| Readonly<{
				status: 'success'
				isPending: false
				data: Result
				error: null
		  }>
		| Readonly<{
				status: 'error'
				isPending: false
				data: undefined
				error: unknown
		  }>
	)

export interface WorkbenchMutationResource<Input, Result> {
	useMutation(): WorkbenchMutationState<Input, WorkbenchDetachedResolvedMutationResult<Result>>
}

export type WorkbenchRendererErrorCode =
	| 'WORKBENCH_RENDERER_CLOSED'
	| 'WORKBENCH_RENDERER_HOOK_INACTIVE'
	| 'WORKBENCH_RENDERER_SCOPE_MISMATCH'
	| 'WORKBENCH_RESOURCE_KEY_INVALID'
	| 'WORKBENCH_RESOURCE_LIMIT_EXCEEDED'
	| 'WORKBENCH_MUTATION_PENDING'

export class WorkbenchRendererError extends Error {
	readonly code: WorkbenchRendererErrorCode
	readonly cause?: unknown

	constructor(code: WorkbenchRendererErrorCode, message: string, cause?: unknown) {
		super(message)
		this.name = 'WorkbenchRendererError'
		this.code = code
		if (cause !== undefined) this.cause = cause
	}
}

export interface WorkbenchRendererScope<Descriptor extends WorkbenchRenderableDescriptor> {
	render(component: ComponentType<WorkbenchZeroProps>): ComponentType<WorkbenchZeroProps>
	useWorkbench(): WorkbenchHookValue<Descriptor>
	query<
		const QueryKey extends readonly WorkbenchResourceKey[],
		const Options extends WorkbenchQueryOptions<QueryKey, unknown>,
	>(
		factory: (
			context: WorkbenchHookValue<Descriptor>,
		) => Options &
			WorkbenchExactOptionsConstraint<Options, WorkbenchQueryOptions<QueryKey, unknown>>,
	): WorkbenchQueryResource<
		Descriptor,
		WorkbenchResolvedResult<WorkbenchQueryFunctionResult<Options>>
	>
	queryFamily<
		Input,
		const QueryKey extends readonly WorkbenchResourceKey[],
		const Options extends WorkbenchQueryOptions<QueryKey, unknown>,
	>(
		factory: (
			context: WorkbenchHookValue<Descriptor>,
			input: Input,
		) => Options &
			WorkbenchExactOptionsConstraint<Options, WorkbenchQueryOptions<QueryKey, unknown>>,
	): WorkbenchQueryFamilyResource<
		Descriptor,
		Input,
		WorkbenchResolvedResult<WorkbenchQueryFunctionResult<Options>>
	>
	mutation<
		MutationFn extends WorkbenchMutationFunction,
		Options extends WorkbenchInferredMutationOptions<Descriptor, MutationFn>,
	>(
		factory: (
			context: WorkbenchMutationExecutionContext<WorkbenchHookValue<Descriptor>>,
		) => Options &
			WorkbenchExactOptionsConstraint<
				Options,
				WorkbenchInferredMutationOptions<Descriptor, MutationFn>
			>,
	): WorkbenchMutationResource<
		WorkbenchMutationFunctionInput<Options['mutationFn']>,
		WorkbenchResolvedResult<WorkbenchMutationFunctionResult<Options['mutationFn']>>
	>
}

type ScopeState<Descriptor extends WorkbenchRenderableDescriptor = WorkbenchRenderableDescriptor> =
	{
		context: ReturnType<typeof createContext<RendererOwner<Descriptor> | null>>
		token: object
		nextResourceId: number
	}

type QueryDefinition<
	Descriptor extends WorkbenchRenderableDescriptor,
	Input,
	QueryKey extends readonly WorkbenchResourceKey[],
	Value,
> = Readonly<{
	scope: ScopeState<Descriptor>
	resource: object
	resourceId: number
	family: boolean
	factory: (
		context: WorkbenchHookValue<Descriptor>,
		input: Input,
	) => WorkbenchQueryOptions<QueryKey, Value>
}>

type NormalizedQueryOptions<
	QueryKey extends readonly WorkbenchResourceKey[] = readonly WorkbenchResourceKey[],
	Value = unknown,
> = Readonly<{
	queryKey: QueryKey
	canonicalKey: string
	queryFn(context: WorkbenchQueryExecutionContext<QueryKey>): WorkbenchAwaitable<Value>
	enabled: boolean
	staleTime: number
	retry: WorkbenchQueryRetry
	retryDelay?: WorkbenchQueryRetryDelay
	subscribe?: (context: WorkbenchQuerySubscriptionContext) => Disposable | PromiseLike<Disposable>
}>

type QueryEntry<
	QueryKey extends readonly WorkbenchResourceKey[] = readonly WorkbenchResourceKey[],
	Value = unknown,
> = {
	resource: object
	canonicalKey: string
	options: NormalizedQueryOptions<QueryKey, Value>
	internalKey: readonly [number, readonly WorkbenchResourceKey[]]
	activeObservers: number
	active: boolean
	lifecycle: number
	revision: number
	subscriptionGeneration: number
	subscriptionController: AbortController | undefined
	subscriptionPromise: Promise<void> | undefined
	pendingSubscription: Disposable | undefined
	subscription: Disposable | undefined
}

type AnyQueryEntry = QueryEntry<any, any>

type QueryObserverLease = {
	entry: AnyQueryEntry
	token: object | undefined
	active: boolean
}

type MutationDefinition<
	Descriptor extends WorkbenchRenderableDescriptor,
	Input,
	Result,
> = Readonly<{
	scope: ScopeState<Descriptor>
	factory: (
		context: WorkbenchMutationExecutionContext<WorkbenchHookValue<Descriptor>>,
	) => WorkbenchMutationOptions<Descriptor, Input, Result>
}>

type NormalizedMutationOptions<Descriptor, Input, Result> = Readonly<{
	mutationFn(input: Input): WorkbenchAwaitable<Result>
	invalidates?:
		| readonly WorkbenchQueryInvalidation<Descriptor>[]
		| ((input: Input) => readonly WorkbenchQueryInvalidation<Descriptor>[])
}>

type MutationSnapshot<Result> =
	| Readonly<{ status: 'idle'; isPending: false; data: undefined; error: null }>
	| Readonly<{ status: 'pending'; isPending: true; data: undefined; error: null }>
	| Readonly<{ status: 'success'; isPending: false; data: Result; error: null }>
	| Readonly<{ status: 'error'; isPending: false; data: undefined; error: unknown }>

type InvalidationMetadata = Readonly<{
	scopeToken: object
	resource: object
	resolve(context: unknown): string
	all: boolean
}>

type ValidatedInvalidation = Readonly<{
	resource: object
	canonicalKey: string | null
	all: boolean
}>

const invalidationMetadata = new WeakMap<object, InvalidationMetadata>()
const disposedValues = new WeakSet<object>()
let nextOwnerId = 0

export function createWorkbenchRenderer<Descriptor extends WorkbenchRenderableDescriptor>(
	descriptor: Descriptor,
): WorkbenchRendererScope<Descriptor> {
	let metadata
	try {
		metadata = readWorkbenchDescriptor(descriptor)
	} catch (cause) {
		throw rendererError(
			'WORKBENCH_RENDERER_SCOPE_MISMATCH',
			'createWorkbenchRenderer() requires a defined Workbench View or Attachment descriptor',
			cause,
		)
	}
	if (metadata.kind !== 'view' && metadata.kind !== 'attachment') {
		throw rendererError(
			'WORKBENCH_RENDERER_SCOPE_MISMATCH',
			'createWorkbenchRenderer() requires a Workbench View or Attachment descriptor',
		)
	}

	const scopeState: ScopeState<Descriptor> = {
		context: createContext<RendererOwner<Descriptor> | null>(null),
		token: Object.freeze({}),
		nextResourceId: 0,
	}

	const scope: WorkbenchRendererScope<Descriptor> = {
		render(component) {
			if (typeof component !== 'function') {
				throw new TypeError('[workbench/react] renderer must be a zero-props React component')
			}
			const ScopedContext = scopeState.context
			function WorkbenchScopedRenderer(): ReactNode {
				const runtime = useWorkbenchReactRuntime()
				const hookValue = useMemo(() => resolveWorkbenchHookValue(runtime, descriptor), [runtime])
				const ownership = useMemo(
					() => ({
						mounts: 0,
						owner: new RendererOwner(scopeState, hookValue, runtime.ownerSignal),
					}),
					[hookValue, runtime.ownerSignal],
				)
				useEffect(() => {
					ownership.mounts += 1
					return () => {
						ownership.mounts -= 1
						queueMicrotask(() => {
							if (ownership.mounts === 0) ownership.owner[Symbol.dispose]()
						})
					}
				}, [ownership])
				return (
					<ScopedContext.Provider key={ownership.owner.id} value={ownership.owner}>
						{createElement(component)}
					</ScopedContext.Provider>
				)
			}
			WorkbenchScopedRenderer.displayName = `WorkbenchRenderer(${component.displayName ?? (component.name || 'Anonymous')})`
			return WorkbenchScopedRenderer
		},
		useWorkbench() {
			return useScopedOwner(scopeState).context
		},
		query(factory) {
			return createQueryResource(scopeState, false, factory as never) as never
		},
		queryFamily(factory) {
			return createQueryResource(scopeState, true, factory as never) as never
		},
		mutation(factory) {
			return createMutationResource(scopeState, factory as never) as never
		},
	}
	return Object.freeze(scope)
}

class RendererOwner<Descriptor extends WorkbenchRenderableDescriptor> implements Disposable {
	readonly id = ++nextOwnerId
	readonly context: WorkbenchHookValue<Descriptor>
	readonly signal: AbortSignal
	readonly queryClient: QueryClient
	readonly #scope: ScopeState<Descriptor>
	readonly #abort = new AbortController()
	readonly #entries = new Map<object, Map<string, AnyQueryEntry>>()
	readonly #entriesByQueryKey = new Map<readonly unknown[], AnyQueryEntry>()
	readonly #observerLeases = new Map<object, QueryObserverLease>()
	readonly #closeListeners = new Set<() => void>()
	readonly #unsubscribeQueryCache: () => void
	readonly #ownerSignal: AbortSignal
	readonly #closeFromOwnerSignal = () => this[Symbol.dispose]()
	#closed = false
	#activeEntries = 0
	#entryCount = 0

	constructor(
		scope: ScopeState<Descriptor>,
		context: WorkbenchHookValue<Descriptor>,
		ownerSignal: AbortSignal,
	) {
		if (ownerSignal.aborted) {
			throw rendererError('WORKBENCH_RENDERER_CLOSED', 'Workbench renderer instance is closed')
		}
		this.#scope = scope
		this.context = context
		this.#ownerSignal = ownerSignal
		this.signal = this.#abort.signal
		this.queryClient = new QueryClient({
			defaultOptions: {
				queries: {
					gcTime: QUERY_GC_TIME,
					networkMode: 'always',
					refetchOnReconnect: false,
					refetchOnWindowFocus: false,
					retry: false,
					structuralSharing: false,
				},
			},
		})
		this.#unsubscribeQueryCache = this.queryClient.getQueryCache().subscribe((event) => {
			if (event.type !== 'removed' || this.#closed) return
			const entry = this.#entriesByQueryKey.get(event.query.queryKey)
			if (entry) this.#removeEntry(entry)
		})
		ownerSignal.addEventListener('abort', this.#closeFromOwnerSignal, { once: true })
	}

	get closed(): boolean {
		return this.#closed
	}

	resolve<Input, QueryKey extends readonly WorkbenchResourceKey[], Value>(
		definition: QueryDefinition<Descriptor, Input, QueryKey, Value>,
		input: Input,
	): QueryEntry<QueryKey, Value> {
		this.#requireActive()
		this.#requireScope(definition.scope)
		const options = this.#resolveOptions(definition, input)
		let resourceEntries = this.#entries.get(definition.resource)
		if (!resourceEntries) {
			resourceEntries = new Map()
			this.#entries.set(definition.resource, resourceEntries)
		}
		const current = resourceEntries.get(options.canonicalKey) as unknown as
			| QueryEntry<QueryKey, Value>
			| undefined
		if (current) return current
		if (this.#entryCount >= MAX_QUERY_ENTRIES) {
			throw rendererError(
				'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
				'Workbench renderer has too many query keys',
			)
		}

		const entry: QueryEntry<QueryKey, Value> = {
			resource: definition.resource,
			canonicalKey: options.canonicalKey,
			options,
			internalKey: Object.freeze([definition.resourceId, options.queryKey]),
			activeObservers: 0,
			active: false,
			lifecycle: 0,
			revision: 0,
			subscriptionGeneration: 0,
			subscriptionController: undefined,
			subscriptionPromise: undefined,
			pendingSubscription: undefined,
			subscription: undefined,
		}
		resourceEntries.set(options.canonicalKey, entry as unknown as AnyQueryEntry)
		this.#entriesByQueryKey.set(entry.internalKey, entry as unknown as AnyQueryEntry)
		this.#entryCount += 1
		return entry
	}

	observe(entry: AnyQueryEntry, enabled: boolean, token?: object): () => void {
		this.#requireActive()
		if (token) {
			const previous = this.#observerLeases.get(token)
			if (previous) this.#releaseObserver(previous)
		}
		if (!enabled) return () => {}
		entry.lifecycle += 1
		if (!entry.active) {
			if (this.#activeEntries >= MAX_ACTIVE_QUERY_ENTRIES) {
				this.#reclaimObserverlessEntries()
			}
			if (this.#activeEntries >= MAX_ACTIVE_QUERY_ENTRIES) {
				throw rendererError(
					'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
					'Workbench renderer has too many active query keys',
				)
			}
			entry.active = true
			this.#activeEntries += 1
		}
		entry.activeObservers += 1
		const lease: QueryObserverLease = { entry, token, active: true }
		if (token) this.#observerLeases.set(token, lease)
		return () => this.#releaseObserver(lease)
	}

	async executeQuery<QueryKey extends readonly WorkbenchResourceKey[], Value>(
		entry: QueryEntry<QueryKey, Value>,
		context: QueryFunctionContext<readonly unknown[]>,
	): Promise<WorkbenchDetached<WorkbenchResolvedResult<Value>>> {
		// Access the query-core signal before awaiting an async Workbench subscription. This makes
		// removeObserver() cancel the fetch even while subscription setup is still pending.
		const signal = context.signal
		try {
			this.#throwIfClosedOrCancelled(signal)
			await this.#ensureSubscription(entry)
			this.#throwIfClosedOrCancelled(signal)
			while (true) {
				const revision = entry.revision
				const authorContext = Object.freeze({
					queryKey: entry.options.queryKey,
					signal,
				}) as WorkbenchQueryExecutionContext<QueryKey>
				const result = entry.options.queryFn(authorContext)
				const value = (await detachWorkbenchPortableValue(
					Promise.resolve(result),
					'Workbench query result',
				)) as WorkbenchDetached<WorkbenchResolvedResult<Value>>
				this.#throwIfClosedOrCancelled(signal)
				if (entry.revision === revision) return value
			}
		} catch (error) {
			if (isWorkbenchQueryBoundaryFailure(error)) throw error
			throw new WorkbenchQueryFailure(error)
		}
	}

	invalidate(entry: AnyQueryEntry): void {
		this.#requireActive()
		entry.revision += 1
		const filters = { queryKey: entry.internalKey, exact: true, refetchType: 'none' as const }
		void this.queryClient.invalidateQueries(filters)
		if (entry.active) {
			void this.queryClient.refetchQueries(
				{ queryKey: entry.internalKey, exact: true, type: 'active' },
				{ cancelRefetch: false },
			)
		}
	}

	refetch<QueryKey extends readonly WorkbenchResourceKey[], Value>(
		entry: QueryEntry<QueryKey, Value>,
		observer: QueryObserver<WorkbenchDetached<WorkbenchResolvedResult<Value>>, unknown>,
	): Promise<WorkbenchDetached<WorkbenchResolvedResult<Value>>> {
		if (this.#closed) return Promise.reject(this.#closedError())
		// Every explicit refetch owns a temporary Workbench lease so concurrent or cancel-restart
		// reads cannot release one another's subscription.
		const release = this.observe(entry, true)
		const operation = observer.refetch({ throwOnError: true }).then(
			(result) => {
				if (this.#closed) throw this.#closedError()
				if (result.status === 'error') throw reportedQueryError(result.error)
				return result.data as WorkbenchDetached<WorkbenchResolvedResult<Value>>
			},
			(error: unknown) => Promise.reject(reportedQueryError(error)),
		)
		const result = this.raceClose(
			operation,
			'Workbench renderer instance closed during query refetch',
		).finally(release)
		void result.catch(() => {})
		return result
	}

	validateInvalidationTargets(targets: readonly unknown[]): readonly ValidatedInvalidation[] {
		this.#requireActive()
		const exactByResource = new Map<object, Map<string, ValidatedInvalidation>>()
		const allByResource = new Map<object, ValidatedInvalidation>()
		for (let index = 0; index < targets.length; index += 1) {
			if (!(index in targets)) {
				throw new TypeError('[workbench/react] mutation invalidates must be a dense array')
			}
			const target = targets[index]
			const metadata =
				(typeof target === 'object' || typeof target === 'function') && target !== null
					? invalidationMetadata.get(target)
					: undefined
			if (!metadata || metadata.scopeToken !== this.#scope.token) {
				throw rendererError(
					'WORKBENCH_RENDERER_SCOPE_MISMATCH',
					'Workbench invalidation target belongs to a different renderer scope',
				)
			}
			if (metadata.all) {
				allByResource.set(
					metadata.resource,
					Object.freeze({
						resource: metadata.resource,
						canonicalKey: null,
						all: true,
					}),
				)
				exactByResource.delete(metadata.resource)
				continue
			}
			if (allByResource.has(metadata.resource)) continue
			const canonicalKey = metadata.resolve(this.context)
			let exact = exactByResource.get(metadata.resource)
			if (!exact) {
				exact = new Map()
				exactByResource.set(metadata.resource, exact)
			}
			exact.set(
				canonicalKey,
				Object.freeze({
					resource: metadata.resource,
					canonicalKey,
					all: false,
				}),
			)
		}
		const validated = [...allByResource.values()]
		for (const targetsForResource of exactByResource.values()) {
			validated.push(...targetsForResource.values())
		}
		return Object.freeze(validated)
	}

	invalidateValidatedTargets(targets: readonly ValidatedInvalidation[]): void {
		if (this.#closed) return
		for (const target of targets) {
			const entries = this.#entries.get(target.resource)
			if (!entries) continue
			if (target.all) {
				for (const entry of entries.values()) this.invalidate(entry)
			} else {
				const entry = entries.get(target.canonicalKey!)
				if (entry) this.invalidate(entry)
			}
		}
	}

	onClose(listener: () => void): () => void {
		if (this.#closed) {
			callSafely(listener)
			return () => {}
		}
		this.#closeListeners.add(listener)
		return () => this.#closeListeners.delete(listener)
	}

	raceClose<Value>(operation: Promise<Value>, message: string): Promise<Value> {
		if (this.#closed) return Promise.reject(this.#closedError())
		let remove = () => {}
		const closed = new Promise<never>((_resolve, reject) => {
			remove = this.onClose(() => reject(rendererError('WORKBENCH_RENDERER_CLOSED', message)))
		})
		const raced = Promise.race([operation, closed]).finally(remove)
		void raced.catch(() => {})
		return raced
	}

	[Symbol.dispose](): void {
		if (this.#closed) return
		this.#closed = true
		this.#ownerSignal.removeEventListener('abort', this.#closeFromOwnerSignal)
		this.#abort.abort()
		for (const listener of this.#closeListeners) callSafely(listener)
		this.#closeListeners.clear()
		for (const entries of this.#entries.values()) {
			for (const entry of entries.values()) this.#disposeEntry(entry)
		}
		this.#entries.clear()
		this.#entriesByQueryKey.clear()
		this.#observerLeases.clear()
		this.#activeEntries = 0
		this.#entryCount = 0
		this.#unsubscribeQueryCache()
		void this.queryClient.cancelQueries(undefined, { silent: true })
		this.queryClient.clear()
	}

	#resolveOptions<Input, QueryKey extends readonly WorkbenchResourceKey[], Value>(
		definition: QueryDefinition<Descriptor, Input, QueryKey, Value>,
		input: Input,
	): NormalizedQueryOptions<QueryKey, Value> {
		let declared: unknown
		try {
			declared = definition.factory(this.context, input)
		} catch (cause) {
			throw new TypeError('[workbench/react] query options factory failed', { cause })
		}
		return normalizeQueryOptions<QueryKey, Value>(declared)
	}

	#requireScope(scope: ScopeState): void {
		if (scope.token !== this.#scope.token) {
			throw rendererError(
				'WORKBENCH_RENDERER_SCOPE_MISMATCH',
				'Workbench resource belongs to a different renderer scope',
			)
		}
	}

	#requireActive(): void {
		if (this.#closed) throw this.#closedError()
	}

	#closedError(): WorkbenchRendererError {
		return rendererError('WORKBENCH_RENDERER_CLOSED', 'Workbench renderer instance is closed')
	}

	#throwIfClosedOrCancelled(signal: AbortSignal): void {
		if (this.#closed) throw this.#closedError()
		if (signal.aborted) throw new CancelledError({ revert: true, silent: true })
	}

	#deactivate(entry: AnyQueryEntry): void {
		entry.active = false
		this.#activeEntries -= 1
		this.#closeSubscription(entry)
		if (entry.options.subscribe) {
			entry.revision += 1
			void this.queryClient.invalidateQueries({
				queryKey: entry.internalKey,
				exact: true,
				refetchType: 'none',
			})
		}
	}

	#releaseObserver(lease: QueryObserverLease): void {
		if (!lease.active) return
		lease.active = false
		if (lease.token && this.#observerLeases.get(lease.token) === lease) {
			this.#observerLeases.delete(lease.token)
		}
		if (this.#closed) return
		const entry = lease.entry
		entry.activeObservers -= 1
		const lifecycle = ++entry.lifecycle
		if (entry.activeObservers !== 0) return
		queueMicrotask(() => {
			if (
				!this.#closed &&
				entry.active &&
				entry.activeObservers === 0 &&
				entry.lifecycle === lifecycle
			) {
				this.#deactivate(entry)
			}
		})
	}

	#reclaimObserverlessEntries(): void {
		for (const entries of this.#entries.values()) {
			for (const entry of entries.values()) {
				if (entry.active && entry.activeObservers === 0) this.#deactivate(entry)
			}
		}
	}

	async #ensureSubscription(entry: AnyQueryEntry): Promise<void> {
		if (!entry.options.subscribe || entry.subscription) return
		if (!entry.active || this.#closed) {
			this.#throwIfClosedOrCancelled(this.signal)
			throw new CancelledError({ revert: true, silent: true })
		}
		if (entry.subscriptionPromise) return entry.subscriptionPromise

		const generation = ++entry.subscriptionGeneration
		const controller = new AbortController()
		entry.subscriptionController = controller
		const operation = this.#openSubscription(entry, generation, controller)
		entry.subscriptionPromise = operation
		try {
			await operation
		} finally {
			if (entry.subscriptionPromise === operation) entry.subscriptionPromise = undefined
		}
	}

	async #openSubscription(
		entry: AnyQueryEntry,
		generation: number,
		controller: AbortController,
	): Promise<void> {
		const invalidate = () => {
			if (this.#closed || !entry.active || entry.subscriptionGeneration !== generation) {
				return
			}
			this.invalidate(entry)
		}
		let returned: Disposable | PromiseLike<Disposable> | undefined
		let pending: Disposable | undefined
		try {
			returned = entry.options.subscribe!(
				Object.freeze({
					signal: controller.signal,
					invalidate,
				}),
			)
			pending = isDisposable(returned) ? returned : undefined
			if (pending) entry.pendingSubscription = pending
			const settled = await returned
			if (!isDisposable(settled)) {
				throw new WorkbenchQueryContractError(
					'[workbench/react] workbench.subscribe must return a Disposable',
				)
			}
			if (this.#closed || !entry.active || entry.subscriptionGeneration !== generation) {
				tryDispose(settled)
				if (entry.pendingSubscription === pending) entry.pendingSubscription = undefined
				throw new CancelledError({ revert: true, silent: true })
			}
			if (entry.pendingSubscription === pending) entry.pendingSubscription = undefined
			entry.subscription = settled
		} catch (error) {
			controller.abort()
			tryDispose(pending)
			if (entry.pendingSubscription === pending) entry.pendingSubscription = undefined
			if (entry.subscriptionGeneration === generation) {
				entry.subscriptionGeneration += 1
				entry.subscriptionController = undefined
			}
			throw error
		}
	}

	#closeSubscription(entry: AnyQueryEntry): void {
		entry.subscriptionGeneration += 1
		entry.subscriptionController?.abort()
		entry.subscriptionController = undefined
		tryDispose(entry.pendingSubscription)
		entry.pendingSubscription = undefined
		tryDispose(entry.subscription)
		entry.subscription = undefined
		entry.subscriptionPromise = undefined
	}

	#disposeEntry(entry: AnyQueryEntry): void {
		entry.lifecycle += 1
		entry.active = false
		entry.activeObservers = 0
		this.#closeSubscription(entry)
	}

	#removeEntry(entry: AnyQueryEntry): void {
		this.#disposeEntry(entry)
		this.#entriesByQueryKey.delete(entry.internalKey)
		const resourceEntries = this.#entries.get(entry.resource)
		if (!resourceEntries?.delete(entry.canonicalKey)) return
		if (resourceEntries.size === 0) this.#entries.delete(entry.resource)
		this.#entryCount -= 1
	}
}

function createQueryResource<
	Descriptor extends WorkbenchRenderableDescriptor,
	Input,
	QueryKey extends readonly WorkbenchResourceKey[],
	Value,
>(
	scope: ScopeState<Descriptor>,
	family: boolean,
	factory: (
		context: WorkbenchHookValue<Descriptor>,
		input: Input,
	) => WorkbenchQueryOptions<QueryKey, Value>,
):
	| WorkbenchQueryResource<Descriptor, WorkbenchResolvedResult<Value>>
	| WorkbenchQueryFamilyResource<Descriptor, Input, WorkbenchResolvedResult<Value>> {
	if (typeof factory !== 'function') {
		throw new TypeError('[workbench/react] query() requires an options factory')
	}
	const resource = {} as Record<string, unknown>
	const definition: QueryDefinition<Descriptor, Input, QueryKey, Value> = Object.freeze({
		scope,
		resource,
		resourceId: ++scope.nextResourceId,
		family,
		factory,
	})
	if (family) {
		Object.assign(resource, {
			useQuery(input: Input) {
				return useQueryResource(definition, input)
			},
			target(input: Input) {
				return createInvalidationTarget(scope, definition, input, false)
			},
			all() {
				return createInvalidationTarget(scope, definition, undefined, true)
			},
		})
	} else {
		Object.assign(resource, {
			useQuery() {
				return useQueryResource(definition, undefined as Input)
			},
		})
		invalidationMetadata.set(
			resource,
			createInvalidationMetadata(scope, definition, undefined, false),
		)
	}
	return Object.freeze(resource) as never
}

function useQueryResource<
	Descriptor extends WorkbenchRenderableDescriptor,
	Input,
	QueryKey extends readonly WorkbenchResourceKey[],
	Value,
>(
	definition: QueryDefinition<Descriptor, Input, QueryKey, Value>,
	input: Input,
): WorkbenchQueryResult<WorkbenchDetached<WorkbenchResolvedResult<Value>>> {
	type DetachedValue = WorkbenchDetached<WorkbenchResolvedResult<Value>>
	const owner = useScopedOwner(definition.scope)
	const entry = owner.resolve(definition, input)
	const observer = useMemo(
		() =>
			new QueryObserver<DetachedValue, unknown>(owner.queryClient, {
				queryKey: entry.internalKey,
				queryFn: (context) => owner.executeQuery(entry, context),
				enabled: entry.options.enabled,
				staleTime: entry.options.staleTime,
				retry: (failureCount, error) => shouldRetry(entry.options.retry, failureCount, error),
				...(entry.options.retryDelay === undefined
					? {}
					: {
							retryDelay: (failureCount: number, error: unknown) =>
								readRetryDelay(entry.options.retryDelay!, failureCount, error),
						}),
				gcTime: QUERY_GC_TIME,
				networkMode: 'always',
				refetchOnReconnect: false,
				refetchOnWindowFocus: false,
				notifyOnChangeProps: 'all',
			}),
		[entry, owner],
	)
	const observerToken = useRef<object>(Object.freeze({})).current
	const hookLease = useMemo(() => ({ active: false }), [observer])
	const subscribe = useCallback(
		(listener: () => void) => {
			hookLease.active = true
			let release = () => {}
			try {
				release = owner.observe(entry, entry.options.enabled, observerToken)
				const unsubscribe = observer.subscribe(listener)
				return () => {
					hookLease.active = false
					unsubscribe()
					release()
				}
			} catch (error) {
				hookLease.active = false
				release()
				throw error
			}
		},
		[entry, hookLease, observer, observerToken, owner],
	)
	const getSnapshot = useCallback(() => observer.getCurrentResult(), [observer])
	const result = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
	const controls = useMemo(
		() => ({
			refetch: () => {
				if (!hookLease.active) return Promise.reject(hookInactiveError())
				return owner.refetch(entry, observer)
			},
			invalidate: () => {
				if (!hookLease.active) throw hookInactiveError()
				owner.invalidate(entry)
			},
		}),
		[entry, hookLease, observer, owner],
	)
	return useMemo(() => projectQueryResult(result, controls), [controls, result])
}

function projectQueryResult<Value>(
	result: QueryObserverResult<Value, unknown>,
	controls: Readonly<{ refetch(): Promise<Value>; invalidate(): void }>,
): WorkbenchQueryResult<Value> {
	const common = {
		isFetching: result.isFetching,
		isStale: result.isStale,
		refetch: controls.refetch,
		invalidate: controls.invalidate,
	}
	if (result.status === 'pending') {
		return Object.freeze({
			...common,
			status: 'pending',
			data: undefined,
			error: null,
			isPending: true,
			isStale: true,
		})
	}
	if (result.status === 'error') {
		return Object.freeze({
			...common,
			status: 'error',
			data: result.data,
			error: reportedQueryError(result.error),
			isPending: false,
			isStale: true,
		})
	}
	return Object.freeze({
		...common,
		status: 'success',
		data: result.data,
		error: null,
		isPending: false,
	})
}

function createMutationResource<Descriptor extends WorkbenchRenderableDescriptor, Input, Result>(
	scope: ScopeState<Descriptor>,
	factory: (
		context: WorkbenchMutationExecutionContext<WorkbenchHookValue<Descriptor>>,
	) => WorkbenchMutationOptions<Descriptor, Input, Result>,
): WorkbenchMutationResource<Input, WorkbenchResolvedResult<Result>> {
	if (typeof factory !== 'function') {
		throw new TypeError('[workbench/react] mutation() requires an options factory')
	}
	const definition: MutationDefinition<Descriptor, Input, Result> = Object.freeze({
		scope,
		factory,
	})
	return Object.freeze({
		useMutation() {
			return useMutationResource(definition)
		},
	}) as WorkbenchMutationResource<Input, WorkbenchResolvedResult<Result>>
}

function useMutationResource<Descriptor extends WorkbenchRenderableDescriptor, Input, Result>(
	definition: MutationDefinition<Descriptor, Input, Result>,
): WorkbenchMutationState<
	Input,
	WorkbenchDetachedResolvedMutationResult<WorkbenchResolvedResult<Result>>
> {
	type DetachedResult = WorkbenchDetachedResolvedMutationResult<WorkbenchResolvedResult<Result>>
	const owner = useScopedOwner(definition.scope)
	const options = useMemo(() => {
		const context = Object.freeze({
			...owner.context,
			signal: owner.signal,
		}) as WorkbenchMutationExecutionContext<WorkbenchHookValue<Descriptor>>
		let declared: unknown
		try {
			declared = definition.factory(context)
		} catch (cause) {
			throw new TypeError('[workbench/react] mutation options factory failed', { cause })
		}
		return normalizeMutationOptions<Descriptor, Input, Result>(declared)
	}, [definition, owner])
	const mounted = useRef(true)
	const pending = useRef(false)
	const sequence = useRef(0)
	const [snapshot, setSnapshot] = useState<MutationSnapshot<DetachedResult>>(() =>
		Object.freeze({ status: 'idle', isPending: false, data: undefined, error: null }),
	)

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])

	const rejectBeforeStart = useCallback((error: unknown): Promise<never> => {
		if (mounted.current) {
			setSnapshot(Object.freeze({ status: 'error', isPending: false, data: undefined, error }))
		}
		return Promise.reject(error)
	}, [])

	const mutateAsync = useCallback(
		(...args: MutationArguments<Input>): Promise<DetachedResult> => {
			if (!mounted.current) return Promise.reject(hookInactiveError())
			if (owner.closed) {
				return rejectBeforeStart(
					rendererError('WORKBENCH_RENDERER_CLOSED', 'Workbench renderer instance is closed'),
				)
			}
			if (pending.current) {
				return Promise.reject(
					rendererError(
						'WORKBENCH_MUTATION_PENDING',
						'Workbench mutation hook already has an active call',
					),
				)
			}
			const input = args[0] as Input
			let targets: readonly ValidatedInvalidation[]
			try {
				const declared =
					typeof options.invalidates === 'function'
						? args.length === 0
							? (options.invalidates as () => readonly WorkbenchQueryInvalidation<Descriptor>[])()
							: options.invalidates(input)
						: (options.invalidates ?? [])
				if (!Array.isArray(declared)) {
					throw new TypeError('[workbench/react] mutation invalidates() must return an array')
				}
				if (declared.length > MAX_MUTATION_INVALIDATIONS) {
					throw rendererError(
						'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
						'Workbench mutation declares too many invalidation targets',
					)
				}
				targets = owner.validateInvalidationTargets(declared)
			} catch (error) {
				return rejectBeforeStart(error)
			}

			pending.current = true
			const current = ++sequence.current
			if (mounted.current) {
				setSnapshot(
					Object.freeze({ status: 'pending', isPending: true, data: undefined, error: null }),
				)
			}

			const operation = (async (): Promise<DetachedResult> => {
				let failure: unknown
				let failed = false
				let value: DetachedResult | undefined
				try {
					const result =
						args.length === 0
							? (options.mutationFn as () => WorkbenchAwaitable<Result>)()
							: options.mutationFn(input)
					const settled = await Promise.resolve(result)
					value = (
						settled === undefined
							? undefined
							: detachWorkbenchPortableValue(settled, 'Workbench mutation result')
					) as DetachedResult
				} catch (error) {
					failed = true
					failure = error
				}

				try {
					owner.invalidateValidatedTargets(targets)
				} catch (error) {
					if (!failed) {
						failed = true
						failure = error
					}
				}
				pending.current = false

				if (owner.closed) {
					throw rendererError(
						'WORKBENCH_RENDERER_CLOSED',
						'Workbench renderer instance closed before its mutation settled',
						failure,
					)
				}
				if (failed) {
					if (mounted.current && sequence.current === current) {
						setSnapshot(
							Object.freeze({
								status: 'error',
								isPending: false,
								data: undefined,
								error: failure,
							}),
						)
					}
					throw failure
				}
				if (mounted.current && sequence.current === current) {
					setSnapshot(
						Object.freeze({
							status: 'success',
							isPending: false,
							data: value as DetachedResult,
							error: null,
						}),
					)
				}
				return value as DetachedResult
			})()
			return owner.raceClose(operation, 'Workbench renderer instance closed during its mutation')
		},
		[options, owner, rejectBeforeStart],
	)

	const mutate = useCallback(
		(...input: MutationArguments<Input>): void => {
			if (!mounted.current) throw hookInactiveError()
			void mutateAsync(...input).catch(() => {})
		},
		[mutateAsync],
	)
	const reset = useCallback(() => {
		if (pending.current || !mounted.current) return
		sequence.current += 1
		setSnapshot(Object.freeze({ status: 'idle', isPending: false, data: undefined, error: null }))
	}, [])

	return useMemo(
		() => Object.freeze({ ...snapshot, mutate, mutateAsync, reset }),
		[mutate, mutateAsync, reset, snapshot],
	) as WorkbenchMutationState<Input, DetachedResult>
}

function useScopedOwner<Descriptor extends WorkbenchRenderableDescriptor>(
	scope: ScopeState<Descriptor>,
): RendererOwner<Descriptor> {
	const owner = useContext(scope.context)
	if (!owner) {
		throw rendererError(
			'WORKBENCH_RENDERER_SCOPE_MISMATCH',
			'Workbench renderer scope hook was called outside scope.render()',
		)
	}
	if (owner.closed) {
		throw rendererError('WORKBENCH_RENDERER_CLOSED', 'Workbench renderer instance is closed')
	}
	return owner
}

function normalizeQueryOptions<
	QueryKey extends readonly WorkbenchResourceKey[] = readonly WorkbenchResourceKey[],
	Value = unknown,
>(input: unknown): NormalizedQueryOptions<QueryKey, Value> {
	const options = readOptionsRecord(input, 'query options')
	assertOnlyKeys(options, [
		'queryKey',
		'queryFn',
		'enabled',
		'staleTime',
		'retry',
		'retryDelay',
		'workbench',
	])
	if (!('queryKey' in options)) {
		throw new TypeError('[workbench/react] query options require queryKey')
	}
	if (typeof options.queryFn !== 'function') {
		throw new TypeError('[workbench/react] query options require queryFn')
	}
	if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
		throw new TypeError('[workbench/react] query enabled must be a boolean')
	}
	if (
		options.staleTime !== undefined &&
		(typeof options.staleTime !== 'number' ||
			options.staleTime < 0 ||
			(!Number.isFinite(options.staleTime) && options.staleTime !== Infinity))
	) {
		throw new TypeError('[workbench/react] query staleTime must be a non-negative number')
	}
	validateRetry(options.retry)
	validateRetryDelay(options.retryDelay)

	let subscribe: NormalizedQueryOptions<QueryKey, Value>['subscribe']
	if (options.workbench !== undefined) {
		const workbench = readOptionsRecord(options.workbench, 'query workbench options')
		assertOnlyKeys(workbench, ['subscribe'])
		if (typeof workbench.subscribe !== 'function') {
			throw new TypeError('[workbench/react] query workbench.subscribe must be a function')
		}
		subscribe = workbench.subscribe as NormalizedQueryOptions<QueryKey, Value>['subscribe']
	}
	const { canonical, key } = normalizeQueryKey(options.queryKey)
	return Object.freeze({
		queryKey: key as QueryKey,
		canonicalKey: canonical,
		queryFn: options.queryFn as NormalizedQueryOptions<QueryKey, Value>['queryFn'],
		enabled: options.enabled !== false,
		staleTime: (options.staleTime as number | undefined) ?? (subscribe ? Infinity : 0),
		retry: (options.retry as WorkbenchQueryRetry | undefined) ?? false,
		...(options.retryDelay === undefined
			? {}
			: { retryDelay: options.retryDelay as WorkbenchQueryRetryDelay }),
		...(subscribe ? { subscribe } : {}),
	})
}

function normalizeMutationOptions<Descriptor, Input, Result>(
	input: unknown,
): NormalizedMutationOptions<Descriptor, Input, Result> {
	const options = readOptionsRecord(input, 'mutation options')
	assertOnlyKeys(options, ['mutationFn', 'workbench'])
	if (typeof options.mutationFn !== 'function') {
		throw new TypeError('[workbench/react] mutation options require mutationFn')
	}
	let invalidates: NormalizedMutationOptions<Descriptor, Input, Result>['invalidates']
	if (options.workbench !== undefined) {
		const workbench = readOptionsRecord(options.workbench, 'mutation workbench options')
		assertOnlyKeys(workbench, ['invalidates'])
		const declared = workbench.invalidates
		if (declared !== undefined && typeof declared !== 'function' && !Array.isArray(declared)) {
			throw new TypeError(
				'[workbench/react] mutation workbench.invalidates must be an array or function',
			)
		}
		invalidates = Array.isArray(declared)
			? (Object.freeze(declared.slice()) as readonly WorkbenchQueryInvalidation<Descriptor>[])
			: (declared as NormalizedMutationOptions<Descriptor, Input, Result>['invalidates'])
	}
	return Object.freeze({
		mutationFn: options.mutationFn as NormalizedMutationOptions<
			Descriptor,
			Input,
			Result
		>['mutationFn'],
		...(invalidates === undefined ? {} : { invalidates }),
	})
}

function readOptionsRecord(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[workbench/react] ${label} must be an object`)
	}
	if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
		throw new TypeError(`[workbench/react] ${label} must be a plain object`)
	}
	if (Object.getOwnPropertySymbols(input).length > 0) {
		throw new TypeError(`[workbench/react] ${label} contains unsupported symbol options`)
	}
	const descriptors = Object.getOwnPropertyDescriptors(input)
	for (const descriptor of Object.values(descriptors)) {
		if (!('value' in descriptor)) {
			throw new TypeError(`[workbench/react] ${label} must not contain accessors`)
		}
	}
	return input as Record<string, unknown>
}

function assertOnlyKeys(options: Record<string, unknown>, allowed: readonly string[]): void {
	const supported = new Set(allowed)
	for (const key of Object.keys(options)) {
		if (!supported.has(key)) {
			throw new TypeError(`[workbench/react] unsupported option "${key}"`)
		}
	}
}

function validateRetry(input: unknown): void {
	if (
		input !== undefined &&
		typeof input !== 'boolean' &&
		typeof input !== 'function' &&
		(typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0)
	) {
		throw new TypeError('[workbench/react] query retry must be a boolean, count, or predicate')
	}
}

function validateRetryDelay(input: unknown): void {
	if (
		input !== undefined &&
		typeof input !== 'function' &&
		(typeof input !== 'number' || !Number.isFinite(input) || input < 0)
	) {
		throw new TypeError(
			'[workbench/react] query retryDelay must be a non-negative number or function',
		)
	}
}

function shouldRetry(declared: WorkbenchQueryRetry, failureCount: number, error: unknown): boolean {
	if (isWorkbenchQueryBoundaryFailure(error)) return false
	const failure = error instanceof WorkbenchQueryFailure ? error : undefined
	if (failure?.stopRetry) return false
	const reported = failure?.reported ?? error
	if (declared === true) return true
	if (declared === false) return false
	if (typeof declared === 'number') return failureCount < declared
	try {
		return declared(failureCount, reported)
	} catch (predicateError) {
		if (failure) failure.reported = predicateError
		return false
	}
}

function readRetryDelay(
	declared: WorkbenchQueryRetryDelay,
	failureCount: number,
	error: unknown,
): number {
	if (isWorkbenchQueryBoundaryFailure(error)) return 0
	if (typeof declared === 'number') return declared
	const failure = error instanceof WorkbenchQueryFailure ? error : undefined
	try {
		const delay = declared(failureCount, failure?.reported ?? error)
		if (!Number.isFinite(delay) || delay < 0) {
			throw new TypeError('[workbench/react] query retryDelay must return a non-negative number')
		}
		return delay
	} catch (delayError) {
		if (failure) {
			failure.reported = delayError
			failure.stopRetry = true
		}
		return 0
	}
}

function isWorkbenchQueryBoundaryFailure(error: unknown): boolean {
	return (
		error instanceof WorkbenchPortableValueError ||
		error instanceof WorkbenchRendererError ||
		error instanceof WorkbenchQueryContractError ||
		isCancelledError(error)
	)
}

function reportedQueryError(error: unknown): unknown {
	return error instanceof WorkbenchQueryFailure ? error.reported : error
}

function createInvalidationTarget<Descriptor extends WorkbenchRenderableDescriptor>(
	scope: ScopeState<Descriptor>,
	definition: QueryDefinition<Descriptor, any, any, any>,
	input: unknown,
	all: boolean,
): WorkbenchQueryInvalidation<Descriptor> {
	const target = Object.freeze({})
	invalidationMetadata.set(target, createInvalidationMetadata(scope, definition, input, all))
	return target as WorkbenchQueryInvalidation<Descriptor>
}

function createInvalidationMetadata<Descriptor extends WorkbenchRenderableDescriptor>(
	scope: ScopeState<Descriptor>,
	definition: QueryDefinition<Descriptor, any, any, any>,
	input: unknown,
	all: boolean,
): InvalidationMetadata {
	return Object.freeze({
		scopeToken: scope.token,
		resource: definition.resource,
		all,
		resolve(context: unknown) {
			if (all) return ''
			let declared: unknown
			try {
				declared = definition.factory(context as WorkbenchHookValue<Descriptor>, input)
			} catch (cause) {
				throw new TypeError('[workbench/react] query options factory failed', { cause })
			}
			return normalizeQueryOptions(declared).canonicalKey
		},
	})
}

function normalizeQueryKey(input: unknown): Readonly<{
	canonical: string
	key: readonly WorkbenchResourceKey[]
}> {
	const canonical = canonicalQueryKey(input)
	return Object.freeze({
		canonical,
		key: cloneResourceKey(input) as readonly WorkbenchResourceKey[],
	})
}

function cloneResourceKey(input: unknown): WorkbenchResourceKey {
	if (input === null) return null
	if (typeof input === 'boolean') return input
	if (typeof input === 'string') return input
	if (typeof input === 'number') return Object.is(input, -0) ? 0 : input
	if (Array.isArray(input)) return Object.freeze(input.map((value) => cloneResourceKey(value)))
	const output = Object.create(null) as Record<string, WorkbenchResourceKey>
	for (const key of Object.keys(input as object).sort()) {
		Object.defineProperty(output, key, {
			value: cloneResourceKey((input as Record<string, unknown>)[key]),
			enumerable: true,
		})
	}
	return Object.freeze(output)
}

function canonicalQueryKey(input: unknown): string {
	if (!Array.isArray(input)) {
		throw rendererError('WORKBENCH_RESOURCE_KEY_INVALID', 'Workbench query key must be an array')
	}
	try {
		return encodeKey(input, 0, new Set(), { nodes: 0, text: 0 })
	} catch (error) {
		if (error instanceof WorkbenchRendererError) throw error
		throw rendererError(
			'WORKBENCH_RESOURCE_KEY_INVALID',
			'Workbench query key is not portable',
			error,
		)
	}
}

function encodeKey(
	input: unknown,
	depth: number,
	ancestors: Set<object>,
	budget: { nodes: number; text: number },
): string {
	budget.nodes += 1
	if (budget.nodes > MAX_KEY_NODES || depth > MAX_KEY_DEPTH) keyLimit()
	if (input === null) return 'l'
	if (typeof input === 'boolean') return input ? 't' : 'f'
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) keyInvalid()
		return `n${Object.is(input, -0) ? 0 : input};`
	}
	if (typeof input === 'string') {
		consumeKeyText(input, budget)
		return `s${input.length}:${input}`
	}
	if (typeof input !== 'object') keyInvalid()
	if (ancestors.has(input)) keyInvalid()
	ancestors.add(input)
	try {
		if (Object.getOwnPropertySymbols(input).length > 0) keyInvalid()
		if (Array.isArray(input)) {
			if (Object.getPrototypeOf(input) !== Array.prototype) keyInvalid()
			if (input.length > MAX_KEY_ARRAY_ITEMS) keyLimit()
			const descriptors = Object.getOwnPropertyDescriptors(input)
			const allowed = new Set(['length', ...Array.from({ length: input.length }, (_, i) => `${i}`)])
			if (Object.keys(descriptors).some((key) => !allowed.has(key))) keyInvalid()
			const parts: string[] = []
			for (let index = 0; index < input.length; index += 1) {
				const descriptor = descriptors[index]
				if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) keyInvalid()
				parts.push(encodeKey(descriptor.value, depth + 1, ancestors, budget))
			}
			return `a${input.length}[${parts.join('')}]`
		}
		const prototype = Object.getPrototypeOf(input)
		if (prototype !== Object.prototype && prototype !== null) keyInvalid()
		const descriptors = Object.getOwnPropertyDescriptors(input)
		const fields = Object.keys(descriptors).sort()
		if (fields.length > MAX_KEY_OBJECT_FIELDS) keyLimit()
		const parts: string[] = []
		for (const key of fields) {
			const descriptor = descriptors[key]
			if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) keyInvalid()
			consumeKeyText(key, budget)
			parts.push(`${key.length}:${key}${encodeKey(descriptor.value, depth + 1, ancestors, budget)}`)
		}
		return `o${fields.length}{${parts.join('')}}`
	} finally {
		ancestors.delete(input)
	}
}

function consumeKeyText(input: string, budget: { nodes: number; text: number }): void {
	budget.text += input.length
	if (budget.text > MAX_KEY_TEXT) keyLimit()
}

function keyInvalid(): never {
	throw rendererError('WORKBENCH_RESOURCE_KEY_INVALID', 'Workbench query key is not portable')
}

function keyLimit(): never {
	throw rendererError(
		'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
		'Workbench query key exceeds its resource budget',
	)
}

function rendererError(
	code: WorkbenchRendererErrorCode,
	message: string,
	cause?: unknown,
): WorkbenchRendererError {
	return new WorkbenchRendererError(code, `[workbench/react] ${message}`, cause)
}

function hookInactiveError(): WorkbenchRendererError {
	return rendererError(
		'WORKBENCH_RENDERER_HOOK_INACTIVE',
		'Workbench resource Hook is no longer active',
	)
}

class WorkbenchQueryContractError extends TypeError {}

class WorkbenchQueryFailure extends Error {
	reported: unknown
	stopRetry = false

	constructor(error: unknown) {
		super('Workbench query failed', { cause: error })
		this.name = 'WorkbenchQueryFailure'
		this.reported = error
	}
}

function isDisposable(input: unknown): input is Disposable {
	return (
		(typeof input === 'object' || typeof input === 'function') &&
		input !== null &&
		typeof (input as Partial<Disposable>)[Symbol.dispose] === 'function'
	)
}

function disposeOnce(input: Disposable | undefined): void {
	if (!input || disposedValues.has(input as object)) return
	disposedValues.add(input as object)
	input[Symbol.dispose]()
}

function tryDispose(input: Disposable | undefined): void {
	try {
		disposeOnce(input)
	} catch {
		// Query teardown remains authoritative when an author-owned disposer is faulty.
	}
}

function callSafely(listener: () => void): void {
	try {
		listener()
	} catch {
		// One framework notification must not prevent the remaining owner cleanup.
	}
}
