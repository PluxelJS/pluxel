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
const MAX_RESOURCE_ENTRIES = 128
const MAX_ACTIVE_QUERY_ENTRIES = 64
const MAX_QUERY_RETRIES = 5
const MAX_MUTATION_INVALIDATIONS = 128

export type WorkbenchZeroProps = Readonly<Record<string, never>>

export type WorkbenchResourceKey =
	| null
	| boolean
	| number
	| string
	| readonly WorkbenchResourceKey[]
	| { readonly [key: string]: WorkbenchResourceKey }

export type WorkbenchQueryExecutionContext<Context> = Context &
	Readonly<{
		/**
		 * Aborted when this read is superseded, becomes unobserved without a waiter, or its
		 * renderer closes. Workbench rejects late commits; the query must observe the signal to
		 * cancel underlying local work that supports cancellation.
		 */
		signal: AbortSignal
	}>

export type WorkbenchQueryRetry =
	| false
	| number
	| ((input: Readonly<{ failureCount: number; error: unknown }>) => boolean)

type WorkbenchAwaitable<Value> = Value | PromiseLike<NoInfer<Value>>

type WorkbenchResolvedResult<Value> = WorkbenchResolvedPortableValue<Value>

export type WorkbenchRendererQueryOptions<Context, Value> = Readonly<{
	queryFn(context: WorkbenchQueryExecutionContext<Context>): WorkbenchAwaitable<Value>
	/** Whether this observer participates in reads and watch ownership. @defaultValue true */
	enabled?: boolean
	/** Milliseconds before cached data becomes stale. Defaults to `0`, or `Infinity` with `watch`. */
	staleTime?: number
	/** Query failure retries; counts are capped at five. @defaultValue false */
	retry?: WorkbenchQueryRetry
	watch?(
		context: WorkbenchQueryExecutionContext<Context>,
		invalidate: () => void,
	): Disposable | PromiseLike<Disposable>
}>

export type WorkbenchRendererKeyedQueryOptions<Context, Input, Value> = Readonly<{
	queryKey(input: Input): readonly WorkbenchResourceKey[]
	queryFn(context: WorkbenchQueryExecutionContext<Context>, input: Input): WorkbenchAwaitable<Value>
	/** Whether this input participates in reads and watch ownership. @defaultValue true */
	enabled?: boolean | ((input: Input) => boolean)
	/** Milliseconds before cached data becomes stale. Defaults to `0`, or `Infinity` with `watch`. */
	staleTime?: number
	/** Query failure retries; counts are capped at five. @defaultValue false */
	retry?: WorkbenchQueryRetry
	watch?(
		context: WorkbenchQueryExecutionContext<Context>,
		input: Input,
		invalidate: () => void,
	): Disposable | PromiseLike<Disposable>
}>

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

export interface WorkbenchKeyedQueryResource<Descriptor, Input, Value> {
	useQuery(input: Input): WorkbenchQueryResult<WorkbenchDetached<Value>>
	target(input: Input): WorkbenchQueryInvalidation<Descriptor>
	all(): WorkbenchQueryInvalidation<Descriptor>
}

export type WorkbenchMutationExecutionContext<Context> = Context &
	Readonly<{
		/**
		 * Aborted when the per-open renderer closes. Hook unmount and `reset()` do not cancel an
		 * accepted mutation, and underlying work must observe the signal to be cancelable.
		 */
		signal: AbortSignal
	}>

export type WorkbenchRendererMutationOptions<
	Descriptor,
	Context,
	Input extends readonly unknown[],
	Result,
> = Readonly<{
	mutationFn(
		context: WorkbenchMutationExecutionContext<Context>,
		...input: Input
	): WorkbenchAwaitable<Result>
	invalidates?:
		| readonly WorkbenchQueryInvalidation<Descriptor>[]
		| ((...input: NoInfer<Input>) => readonly WorkbenchQueryInvalidation<Descriptor>[])
}>

type WorkbenchDetachedResolvedMutationResult<Result> = Result extends void
	? void
	: WorkbenchDetached<Result>

type WorkbenchDetachedMutationResult<Result> = WorkbenchDetachedResolvedMutationResult<
	WorkbenchResolvedResult<Result>
>

type WorkbenchMutationControls<Input extends readonly unknown[], Result> = Readonly<{
	/** Starts an operation and reports its outcome through this Hook's state. */
	mutate(...input: Input): void
	/** Starts an operation and returns its detached result to the caller. */
	mutateAsync(...input: Input): Promise<Result>
	/** Clears settled state. It neither cancels nor resets a pending operation. */
	reset(): void
}>

export type WorkbenchMutationState<
	Input extends readonly unknown[],
	Result,
> = WorkbenchMutationControls<Input, Result> &
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

export interface WorkbenchMutationResource<Input extends readonly unknown[], Result> {
	useMutation(): WorkbenchMutationState<Input, WorkbenchDetachedResolvedMutationResult<Result>>
}

export type WorkbenchRendererErrorCode =
	| 'WORKBENCH_RENDERER_CLOSED'
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
	query<Input, Value>(
		options: WorkbenchRendererKeyedQueryOptions<WorkbenchHookValue<Descriptor>, Input, Value>,
	): WorkbenchKeyedQueryResource<Descriptor, Input, WorkbenchResolvedResult<Value>>
	query<Value>(
		options: WorkbenchRendererQueryOptions<WorkbenchHookValue<Descriptor>, Value>,
	): WorkbenchQueryResource<Descriptor, WorkbenchResolvedResult<Value>>
	mutation<Input extends readonly unknown[], Result>(
		options: WorkbenchRendererMutationOptions<
			Descriptor,
			WorkbenchHookValue<Descriptor>,
			Input,
			Result
		>,
	): WorkbenchMutationResource<Input, WorkbenchResolvedResult<Result>>
}

type AnyQueryOptions<Context, Input, Value> =
	| WorkbenchRendererQueryOptions<Context, Value>
	| WorkbenchRendererKeyedQueryOptions<Context, Input, Value>

type QueryResourceDefinition<
	Descriptor extends WorkbenchRenderableDescriptor,
	Context,
	Input,
	Value,
> = Readonly<{
	scope: ScopeState<Descriptor>
	keyed: boolean
	options: AnyQueryOptions<Context, Input, Value>
	resource: object
}>

type MutationResourceDefinition<
	Descriptor extends WorkbenchRenderableDescriptor,
	Context,
	Input extends readonly unknown[],
	Result,
> = Readonly<{
	scope: ScopeState<Descriptor>
	options: WorkbenchRendererMutationOptions<Descriptor, Context, Input, Result>
	resource: object
}>

type MutationSnapshot<Result> =
	| Readonly<{ status: 'idle'; isPending: false; data: undefined; error: null }>
	| Readonly<{ status: 'pending'; isPending: true; data: undefined; error: null }>
	| Readonly<{ status: 'success'; isPending: false; data: Result; error: null }>
	| Readonly<{ status: 'error'; isPending: false; data: undefined; error: unknown }>

type QueryEntry<Value = unknown> = {
	resource: QueryResourceDefinition<any, any, any, Value>
	cacheKey: string
	input: unknown
	listeners: Map<() => void, boolean>
	enabledObservers: number
	snapshot: WorkbenchQueryResult<WorkbenchDetached<Value>>
	status: 'pending' | 'success' | 'error'
	data: WorkbenchDetached<Value> | undefined
	error: unknown
	stale: boolean
	fetching: boolean
	updatedAt: number
	lastUsed: number
	desiredRevision: number
	processedRevision: number
	running: Promise<void> | undefined
	readController: AbortController | undefined
	watchController: AbortController | undefined
	watchGeneration: number
	watch: Disposable | undefined
	watchPending: Disposable | undefined
	retryTimer: ReturnType<typeof setTimeout> | undefined
	retryResolve: (() => void) | undefined
	cleanupVersion: number
	waiters: Set<QueryWaiter<Value>>
	refetch: () => Promise<WorkbenchDetached<Value>>
	invalidate: () => void
}

type QueryWaiter<Value> = {
	resolve(value: WorkbenchDetached<Value>): void
	reject(error: unknown): void
}

type ScopeState<Descriptor extends WorkbenchRenderableDescriptor = WorkbenchRenderableDescriptor> =
	{
		context: ReturnType<typeof createContext<RendererOwner<Descriptor> | null>>
		token: object
	}

type InvalidationMetadata = Readonly<{
	scopeToken: object
	resource: object
	cacheKey: string | null
	all: boolean
}>

const invalidationMetadata = new WeakMap<object, InvalidationMetadata>()
const disposedValues = new WeakSet<object>()

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
	}

	const scope = {
		render(component: ComponentType<WorkbenchZeroProps>) {
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
						owner: new RendererOwner(scopeState, hookValue),
					}),
					[hookValue],
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
					<ScopedContext.Provider value={ownership.owner}>
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
		query<Input, Value>(
			options:
				| WorkbenchRendererQueryOptions<WorkbenchHookValue<Descriptor>, Value>
				| WorkbenchRendererKeyedQueryOptions<WorkbenchHookValue<Descriptor>, Input, Value>,
		) {
			return createQueryResource(scopeState, options)
		},
		mutation<Input extends readonly unknown[], Result>(
			options: WorkbenchRendererMutationOptions<
				Descriptor,
				WorkbenchHookValue<Descriptor>,
				Input,
				Result
			>,
		) {
			return createMutationResource(scopeState, options)
		},
	}
	return Object.freeze(scope) as WorkbenchRendererScope<Descriptor>
}

class RendererOwner<Descriptor extends WorkbenchRenderableDescriptor> implements Disposable {
	readonly context: WorkbenchHookValue<Descriptor>
	readonly signal: AbortSignal
	readonly #scope: ScopeState<Descriptor>
	readonly #abort = new AbortController()
	readonly #entries = new Map<object, Map<string, QueryEntry>>()
	readonly #closeListeners = new Set<() => void>()
	#closed = false
	#activeEntries = 0
	#entryCount = 0
	#clock = 0

	constructor(scope: ScopeState<Descriptor>, context: WorkbenchHookValue<Descriptor>) {
		this.#scope = scope
		this.context = context
		this.signal = this.#abort.signal
	}

	get closed(): boolean {
		return this.#closed
	}

	resolve<Value>(
		resource: QueryResourceDefinition<Descriptor, WorkbenchHookValue<Descriptor>, unknown, Value>,
		cacheKey: string,
		input: unknown,
	): QueryEntry<Value> {
		this.#requireActive()
		if (resource.scope.token !== this.#scope.token) {
			throw rendererError(
				'WORKBENCH_RENDERER_SCOPE_MISMATCH',
				'Workbench query resource belongs to a different renderer scope',
			)
		}
		let resourceEntries = this.#entries.get(resource.resource)
		if (!resourceEntries) {
			resourceEntries = new Map()
			this.#entries.set(resource.resource, resourceEntries)
		}
		const current = resourceEntries.get(cacheKey) as QueryEntry<Value> | undefined
		if (current) {
			current.lastUsed = ++this.#clock
			return current
		}
		this.#admitEntry(resourceEntries)
		// Global eviction can remove the last entry in this resource and detach its local map.
		// Reattach that same map before publishing the admitted entry.
		if (!this.#entries.has(resource.resource)) {
			this.#entries.set(resource.resource, resourceEntries)
		}
		const entry = createQueryEntry(this, resource, cacheKey, input, ++this.#clock)
		resourceEntries.set(cacheKey, entry as QueryEntry)
		this.#entryCount += 1
		return entry
	}

	subscribe<Value>(entry: QueryEntry<Value>, listener: () => void, enabled: boolean): () => void {
		this.#requireActive()
		if (entry.listeners.has(listener)) return () => {}
		entry.listeners.set(listener, enabled)
		entry.lastUsed = ++this.#clock
		if (enabled) {
			entry.cleanupVersion += 1
			const activate = entry.enabledObservers === 0
			if (activate) {
				if (this.#activeEntries >= MAX_ACTIVE_QUERY_ENTRIES) {
					entry.listeners.delete(listener)
					throw rendererError(
						'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
						'Workbench renderer has too many active query keys',
					)
				}
				this.#activeEntries += 1
			}
			entry.enabledObservers += 1
			if (activate) this.#activate(entry)
		}
		let subscribed = true
		return () => {
			if (!subscribed) return
			subscribed = false
			if (!entry.listeners.delete(listener)) return
			if (enabled) {
				entry.enabledObservers -= 1
				if (entry.enabledObservers === 0) {
					this.#activeEntries -= 1
					const cleanupVersion = ++entry.cleanupVersion
					queueMicrotask(() => {
						if (
							!this.#closed &&
							entry.enabledObservers === 0 &&
							entry.cleanupVersion === cleanupVersion
						) {
							this.#deactivate(entry)
						}
					})
				}
			}
		}
	}

	refetch<Value>(entry: QueryEntry<Value>): Promise<WorkbenchDetached<Value>> {
		if (this.#closed) {
			return Promise.reject(
				rendererError('WORKBENCH_RENDERER_CLOSED', 'Workbench renderer instance is closed'),
			)
		}
		this.#request(entry, true)
		return new Promise((resolve, reject) => {
			entry.waiters.add({ resolve, reject })
		})
	}

	invalidate(entry: QueryEntry): void {
		this.#requireActive()
		entry.stale = true
		this.#refreshSnapshot(entry)
		if (entry.enabledObservers > 0) this.#request(entry, false)
	}

	invalidateTarget(target: object): void {
		this.#requireActive()
		const metadata = invalidationMetadata.get(target)
		if (!metadata || metadata.scopeToken !== this.#scope.token) {
			throw rendererError(
				'WORKBENCH_RENDERER_SCOPE_MISMATCH',
				'Workbench invalidation target belongs to a different renderer scope',
			)
		}
		const entries = this.#entries.get(metadata.resource)
		if (!entries) return
		if (metadata.all) {
			for (const entry of entries.values()) this.invalidate(entry)
			return
		}
		const entry = entries.get(metadata.cacheKey!)
		if (entry) this.invalidate(entry)
	}

	validateInvalidationTargets(targets: readonly object[]): readonly InvalidationMetadata[] {
		this.#requireActive()
		return Object.freeze(
			targets.map((target) => {
				const metadata = invalidationMetadata.get(target)
				if (!metadata || metadata.scopeToken !== this.#scope.token) {
					throw rendererError(
						'WORKBENCH_RENDERER_SCOPE_MISMATCH',
						'Workbench invalidation target belongs to a different renderer scope',
					)
				}
				return metadata
			}),
		)
	}

	invalidateValidatedTargets(targets: readonly InvalidationMetadata[]): void {
		if (this.#closed) return
		for (const target of targets) {
			const entries = this.#entries.get(target.resource)
			if (!entries) continue
			if (target.all) {
				for (const entry of entries.values()) this.invalidate(entry)
			} else {
				const entry = entries.get(target.cacheKey!)
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

	[Symbol.dispose](): void {
		if (this.#closed) return
		this.#closed = true
		this.#abort.abort()
		for (const listener of this.#closeListeners) callSafely(listener)
		this.#closeListeners.clear()
		const error = rendererError(
			'WORKBENCH_RENDERER_CLOSED',
			'Workbench renderer instance is closed',
		)
		for (const entries of this.#entries.values()) {
			for (const entry of entries.values()) {
				entry.cleanupVersion += 1
				entry.readController?.abort()
				entry.watchController?.abort()
				this.#cancelRetry(entry)
				try {
					this.#disposeWatch(entry)
				} catch {
					// Closing the owner is authoritative even when an author disposer is faulty.
				}
				for (const waiter of entry.waiters) waiter.reject(error)
				entry.waiters.clear()
				entry.listeners.clear()
			}
		}
		this.#entries.clear()
		this.#entryCount = 0
		this.#activeEntries = 0
	}

	#requireActive(): void {
		if (this.#closed) {
			throw rendererError('WORKBENCH_RENDERER_CLOSED', 'Workbench renderer instance is closed')
		}
	}

	#admitEntry(resourceEntries: Map<string, QueryEntry>): void {
		while (this.#entryCount >= MAX_QUERY_ENTRIES || resourceEntries.size >= MAX_RESOURCE_ENTRIES) {
			let candidate: QueryEntry | undefined
			const candidateMaps =
				resourceEntries.size >= MAX_RESOURCE_ENTRIES ? [resourceEntries] : this.#entries.values()
			for (const entries of candidateMaps) {
				for (const entry of entries.values()) {
					if (
						entry.listeners.size === 0 &&
						entry.running === undefined &&
						entry.watch === undefined &&
						(!candidate || entry.lastUsed < candidate.lastUsed)
					) {
						candidate = entry
					}
				}
			}
			if (!candidate) {
				throw rendererError(
					'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
					'Workbench renderer query cache limit was exceeded',
				)
			}
			this.#deleteEntry(candidate)
		}
	}

	#deleteEntry(entry: QueryEntry): void {
		const entries = this.#entries.get(entry.resource.resource)
		if (!entries?.delete(entry.cacheKey)) return
		if (entries.size === 0) this.#entries.delete(entry.resource.resource)
		this.#entryCount -= 1
	}

	#activate(entry: QueryEntry): void {
		const watched = getWatch(entry.resource.options) !== undefined
		if (watched) entry.stale = true
		const staleTime = getStaleTime(entry.resource.options, watched)
		const fresh =
			entry.status === 'success' &&
			!entry.stale &&
			(Date.now() - entry.updatedAt < staleTime || staleTime === Infinity)
		if (!fresh) this.#request(entry, false)
	}

	#deactivate(entry: QueryEntry): void {
		entry.cleanupVersion += 1
		entry.watchGeneration += 1
		entry.watchController?.abort()
		entry.watchController = undefined
		try {
			this.#disposeWatch(entry)
		} catch {
			// An inactive query has no observer error channel; cleanup must still complete.
		}
		if (getWatch(entry.resource.options)) entry.stale = true
		if (entry.waiters.size === 0) {
			entry.readController?.abort()
			this.#cancelRetry(entry)
		}
		this.#refreshSnapshot(entry)
	}

	#request(entry: QueryEntry, explicit: boolean): void {
		entry.stale = true
		if (entry.running) {
			if (entry.desiredRevision === entry.processedRevision + 1) {
				entry.desiredRevision += 1
				entry.readController?.abort()
			}
		} else {
			entry.desiredRevision += 1
		}
		this.#refreshSnapshot(entry)
		if (explicit || entry.enabledObservers > 0) this.#run(entry)
	}

	#run(entry: QueryEntry): void {
		if (entry.running || this.#closed) return
		const running = Promise.resolve().then(() => this.#runLoop(entry))
		const handled = running.catch((error: unknown) => {
			if (!this.#closed && (entry.enabledObservers > 0 || entry.waiters.size > 0)) {
				entry.processedRevision = entry.desiredRevision
				entry.status = 'error'
				entry.error = error
				entry.stale = true
				this.#rejectWaiters(entry, error)
			}
		})
		entry.running = handled.finally(() => {
			entry.running = undefined
			entry.readController = undefined
			entry.fetching = false
			this.#refreshSnapshot(entry)
			if (
				!this.#closed &&
				entry.desiredRevision > entry.processedRevision &&
				(entry.enabledObservers > 0 || entry.waiters.size > 0)
			) {
				this.#run(entry)
			}
		})
	}

	async #runLoop(entry: QueryEntry): Promise<void> {
		while (
			!this.#closed &&
			entry.desiredRevision > entry.processedRevision &&
			(entry.enabledObservers > 0 || entry.waiters.size > 0)
		) {
			let revision = entry.desiredRevision
			entry.fetching = true
			this.#refreshSnapshot(entry)
			let failureCount = 0
			while (!this.#closed) {
				try {
					await this.#ensureWatch(entry)
					if (this.#closed || (entry.enabledObservers === 0 && entry.waiters.size === 0)) {
						entry.processedRevision = revision
						break
					}
					revision = entry.desiredRevision
					const controller = new AbortController()
					entry.readController = controller
					const context = executionContext(this.context, controller.signal)
					const query = getQueryFn(entry.resource.options)
					const input = entry.input
					const result = entry.resource.keyed ? query(context, input) : query(context)
					const value = (await detachWorkbenchPortableValue(
						Promise.resolve(result),
						'Workbench query result',
					)) as WorkbenchDetached<unknown>
					entry.processedRevision = revision
					if (
						!this.#closed &&
						entry.desiredRevision === revision &&
						(entry.enabledObservers > 0 || entry.waiters.size > 0)
					) {
						entry.status = 'success'
						entry.data = value
						entry.error = null
						entry.stale = false
						entry.updatedAt = Date.now()
						this.#resolveWaiters(entry, value)
					}
					break
				} catch (caught) {
					if (this.#closed) break
					if (entry.desiredRevision !== revision) {
						entry.processedRevision = revision
						break
					}
					let error = caught
					failureCount += 1
					let retry = false
					try {
						retry = this.#shouldRetry(entry, failureCount, error)
					} catch (retryError) {
						error = retryError
					}
					if (retry) {
						await this.#retryDelay(entry, failureCount)
						if (this.#closed || (entry.enabledObservers === 0 && entry.waiters.size === 0)) {
							entry.processedRevision = revision
							break
						}
						continue
					}
					entry.processedRevision = revision
					if (!this.#closed && (entry.enabledObservers > 0 || entry.waiters.size > 0)) {
						entry.status = 'error'
						entry.error = error
						entry.stale = true
						this.#rejectWaiters(entry, error)
					}
					break
				}
			}
		}
	}

	async #ensureWatch(entry: QueryEntry): Promise<void> {
		const watch = getWatch(entry.resource.options)
		if (!watch || entry.watch) return
		if (entry.enabledObservers === 0) return
		const generation = ++entry.watchGeneration
		const controller = new AbortController()
		entry.watchController = controller
		const invalidate = () => {
			if (this.#closed || entry.enabledObservers === 0 || entry.watchGeneration !== generation) {
				return
			}
			this.invalidate(entry)
		}
		const context = executionContext(this.context, controller.signal)
		try {
			const pending = entry.resource.keyed
				? watch(context, entry.input, invalidate)
				: watch(context, invalidate)
			entry.watchPending = isDisposable(pending) ? pending : undefined
			const settled = await pending
			if (!isDisposable(settled)) {
				throw new TypeError('[workbench/react] query watch() must return a Disposable')
			}
			if (this.#closed || entry.enabledObservers === 0 || entry.watchGeneration !== generation) {
				disposeOnce(settled)
				entry.watchPending = undefined
				return
			}
			entry.watch = settled
			entry.watchPending = undefined
		} catch (error) {
			controller.abort()
			try {
				this.#disposeWatch(entry)
			} catch {
				// Preserve the watch/read failure that selected this retry path.
			}
			if (entry.watchGeneration === generation) entry.watchController = undefined
			throw error
		}
	}

	#disposeWatch(entry: QueryEntry): void {
		const watch = entry.watch
		const pending = entry.watchPending
		entry.watch = undefined
		entry.watchPending = undefined
		let failure: unknown
		try {
			disposeOnce(watch)
		} catch (error) {
			failure = error
		}
		if (pending !== watch) {
			try {
				disposeOnce(pending)
			} catch (error) {
				failure ??= error
			}
		}
		if (failure !== undefined) throw failure
	}

	#shouldRetry(entry: QueryEntry, failureCount: number, error: unknown): boolean {
		if (
			this.#closed ||
			(entry.enabledObservers === 0 && entry.waiters.size === 0) ||
			error instanceof WorkbenchRendererError ||
			error instanceof WorkbenchPortableValueError
		) {
			return false
		}
		const retry = entry.resource.options.retry
		if (retry === undefined || retry === false) return false
		if (failureCount > MAX_QUERY_RETRIES) return false
		if (typeof retry === 'number') return failureCount <= Math.min(retry, MAX_QUERY_RETRIES)
		return retry(Object.freeze({ failureCount, error })) === true
	}

	#retryDelay(entry: QueryEntry, failureCount: number): Promise<void> {
		return new Promise((resolve) => {
			entry.retryResolve = resolve
			entry.retryTimer = setTimeout(
				() => {
					entry.retryTimer = undefined
					entry.retryResolve = undefined
					resolve()
				},
				Math.min(250 * 2 ** (failureCount - 1), 4_000),
			)
		})
	}

	#cancelRetry(entry: QueryEntry): void {
		if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer)
		entry.retryTimer = undefined
		const resolve = entry.retryResolve
		entry.retryResolve = undefined
		resolve?.()
	}

	#resolveWaiters<Value>(entry: QueryEntry<Value>, value: WorkbenchDetached<Value>): void {
		for (const waiter of entry.waiters) waiter.resolve(value)
		entry.waiters.clear()
	}

	#rejectWaiters<Value>(entry: QueryEntry<Value>, error: unknown): void {
		for (const waiter of entry.waiters) waiter.reject(error)
		entry.waiters.clear()
	}

	#refreshSnapshot(entry: QueryEntry): void {
		if (this.#closed) return
		entry.snapshot = createSnapshot(entry)
		for (const listener of entry.listeners.keys()) callSafely(listener)
	}
}

function createQueryResource<Descriptor extends WorkbenchRenderableDescriptor, Input, Value>(
	scope: ScopeState<Descriptor>,
	options:
		| WorkbenchRendererQueryOptions<WorkbenchHookValue<Descriptor>, Value>
		| WorkbenchRendererKeyedQueryOptions<WorkbenchHookValue<Descriptor>, Input, Value>,
):
	| WorkbenchQueryResource<Descriptor, WorkbenchResolvedResult<Value>>
	| WorkbenchKeyedQueryResource<Descriptor, Input, WorkbenchResolvedResult<Value>> {
	const normalized = normalizeOptions(options)
	const keyed = 'queryKey' in normalized
	const resource = {} as Record<string, unknown>
	const definition: QueryResourceDefinition<
		Descriptor,
		WorkbenchHookValue<Descriptor>,
		Input,
		Value
	> = Object.freeze({ scope, keyed, options: normalized, resource })
	if (keyed) {
		Object.assign(resource, {
			useQuery(input: Input) {
				return useQueryResource(definition, input, canonicalQueryKey(normalized.queryKey(input)))
			},
			target(input: Input) {
				return createInvalidationTarget(
					scope,
					resource,
					canonicalQueryKey(normalized.queryKey(input)),
					false,
				)
			},
			all() {
				return createInvalidationTarget(scope, resource, null, true)
			},
		})
	} else {
		Object.assign(resource, {
			useQuery() {
				return useQueryResource(definition, undefined, 'singleton')
			},
		})
		invalidationMetadata.set(
			resource,
			Object.freeze({
				scopeToken: scope.token,
				resource,
				cacheKey: 'singleton',
				all: false,
			}),
		)
	}
	return Object.freeze(resource) as never
}

function createMutationResource<
	Descriptor extends WorkbenchRenderableDescriptor,
	Input extends readonly unknown[],
	Result,
>(
	scope: ScopeState<Descriptor>,
	options: WorkbenchRendererMutationOptions<
		Descriptor,
		WorkbenchHookValue<Descriptor>,
		Input,
		Result
	>,
): WorkbenchMutationResource<Input, WorkbenchResolvedResult<Result>> {
	const normalized = normalizeMutationOptions(options)
	const resource = {} as Record<string, unknown>
	const definition: MutationResourceDefinition<
		Descriptor,
		WorkbenchHookValue<Descriptor>,
		Input,
		Result
	> = Object.freeze({ scope, options: normalized, resource })
	Object.assign(resource, {
		useMutation() {
			return useMutationResource(definition)
		},
	})
	return Object.freeze(resource) as unknown as WorkbenchMutationResource<
		Input,
		WorkbenchResolvedResult<Result>
	>
}

function useMutationResource<
	Descriptor extends WorkbenchRenderableDescriptor,
	Input extends readonly unknown[],
	Result,
>(
	resource: MutationResourceDefinition<Descriptor, WorkbenchHookValue<Descriptor>, Input, Result>,
): WorkbenchMutationState<Input, WorkbenchDetachedMutationResult<Result>> {
	type DetachedResult = WorkbenchDetachedMutationResult<Result>
	const owner = useScopedOwner(resource.scope)
	const mounted = useRef(true)
	const pending = useRef(false)
	const sequence = useRef(0)
	const [snapshot, setSnapshot] = useState<MutationSnapshot<DetachedResult>>(() =>
		Object.freeze({ status: 'idle', isPending: false, data: undefined, error: null }),
	)
	const rejectBeforeStart = useCallback((error: unknown): Promise<never> => {
		if (mounted.current) {
			setSnapshot(
				Object.freeze({
					status: 'error',
					isPending: false,
					data: undefined,
					error,
				}),
			)
		}
		return Promise.reject(error)
	}, [])

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])

	const mutateAsync = useCallback(
		(...input: Input): Promise<DetachedResult> => {
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

			let targets: readonly InvalidationMetadata[]
			try {
				const invalidates = resource.options.invalidates
				const declared =
					typeof invalidates === 'function' ? invalidates(...input) : (invalidates ?? [])
				if (!Array.isArray(declared)) {
					throw new TypeError('[workbench/react] mutation invalidates() must return an array')
				}
				if (declared.length > MAX_MUTATION_INVALIDATIONS) {
					throw rendererError(
						'WORKBENCH_RESOURCE_LIMIT_EXCEEDED',
						'Workbench mutation declares too many invalidation targets',
					)
				}
				targets = owner.validateInvalidationTargets(declared as readonly object[])
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
				let failed = false
				let failure: unknown
				let value: DetachedResult | undefined
				try {
					const context = executionContext(
						owner.context,
						owner.signal,
					) as WorkbenchMutationExecutionContext<WorkbenchHookValue<Descriptor>>
					const result = resource.options.mutationFn(context, ...input)
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

			let removeCloseListener = () => {}
			const closed = new Promise<never>((_resolve, reject) => {
				removeCloseListener = owner.onClose(() => {
					reject(
						rendererError(
							'WORKBENCH_RENDERER_CLOSED',
							'Workbench renderer instance closed during its mutation',
						),
					)
				})
			})
			return Promise.race([operation, closed]).finally(removeCloseListener)
		},
		[owner, rejectBeforeStart, resource],
	)

	const mutate = useCallback(
		(...input: Input): void => {
			// Accepted operation failures and preflight failures are already represented by
			// mutation state. A second call while pending intentionally preserves that state.
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

function useQueryResource<Descriptor extends WorkbenchRenderableDescriptor, Input, Value>(
	resource: QueryResourceDefinition<Descriptor, WorkbenchHookValue<Descriptor>, Input, Value>,
	input: Input,
	cacheKey: string,
): WorkbenchQueryResult<WorkbenchDetached<WorkbenchResolvedResult<Value>>> {
	const owner = useScopedOwner(resource.scope)
	const enabled = readEnabled(resource.options, input)
	const entry = owner.resolve(resource as never, cacheKey, input)
	const subscribe = useCallback(
		(listener: () => void) => owner.subscribe(entry, listener, enabled),
		[enabled, entry, owner],
	)
	const getSnapshot = useCallback(() => entry.snapshot, [entry])
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as WorkbenchQueryResult<
		WorkbenchDetached<WorkbenchResolvedResult<Value>>
	>
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

function createQueryEntry<Value>(
	owner: RendererOwner<any>,
	resource: QueryResourceDefinition<any, any, any, Value>,
	cacheKey: string,
	input: unknown,
	lastUsed: number,
): QueryEntry<Value> {
	const entry: QueryEntry<Value> = {
		resource,
		cacheKey,
		input,
		listeners: new Map(),
		enabledObservers: 0,
		status: 'pending' as const,
		data: undefined,
		error: null,
		stale: true,
		fetching: false,
		updatedAt: 0,
		lastUsed,
		desiredRevision: 0,
		processedRevision: 0,
		running: undefined,
		readController: undefined,
		watchController: undefined,
		watchGeneration: 0,
		watch: undefined,
		watchPending: undefined,
		retryTimer: undefined,
		retryResolve: undefined,
		cleanupVersion: 0,
		waiters: new Set(),
		refetch: undefined as unknown as () => Promise<WorkbenchDetached<Value>>,
		invalidate: undefined as unknown as () => void,
		snapshot: undefined as unknown as WorkbenchQueryResult<WorkbenchDetached<Value>>,
	}
	entry.refetch = () => owner.refetch(entry)
	entry.invalidate = () => owner.invalidate(entry)
	entry.snapshot = createSnapshot(entry)
	return entry
}

function createSnapshot<Value>(
	entry: QueryEntry<Value>,
): WorkbenchQueryResult<WorkbenchDetached<Value>> {
	const controls = {
		isFetching: entry.fetching,
		isStale: entry.stale,
		refetch: entry.refetch,
		invalidate: entry.invalidate,
	}
	if (entry.status === 'pending') {
		return Object.freeze({
			...controls,
			status: 'pending',
			data: undefined,
			error: null,
			isPending: true,
			isStale: true,
		})
	}
	if (entry.status === 'error') {
		return Object.freeze({
			...controls,
			status: 'error',
			data: entry.data,
			error: entry.error,
			isPending: false,
			isStale: true,
		})
	}
	return Object.freeze({
		...controls,
		status: 'success',
		data: entry.data!,
		error: null,
		isPending: false,
	})
}

function normalizeOptions<Context, Input, Value>(
	options: AnyQueryOptions<Context, Input, Value>,
): AnyQueryOptions<Context, Input, Value> {
	if (!options || typeof options !== 'object' || typeof options.queryFn !== 'function') {
		throw new TypeError('[workbench/react] query() requires queryFn')
	}
	if ('workbench' in options) {
		throw new TypeError('[workbench/react] query options do not support a workbench namespace')
	}
	const keyed = 'queryKey' in options
	if (keyed && typeof options.queryKey !== 'function') {
		throw new TypeError('[workbench/react] keyed query() requires queryKey')
	}
	if (
		options.staleTime !== undefined &&
		(options.staleTime < 0 ||
			(!Number.isFinite(options.staleTime) && options.staleTime !== Infinity))
	) {
		throw new TypeError('[workbench/react] query staleTime must be non-negative')
	}
	if (
		options.retry !== undefined &&
		options.retry !== false &&
		typeof options.retry !== 'function' &&
		(typeof options.retry !== 'number' || !Number.isSafeInteger(options.retry) || options.retry < 0)
	) {
		throw new TypeError('[workbench/react] query retry must be false, a count, or a predicate')
	}
	if (options.watch !== undefined && typeof options.watch !== 'function') {
		throw new TypeError('[workbench/react] query watch must be a function')
	}
	return Object.freeze({
		...(keyed ? { queryKey: options.queryKey } : {}),
		queryFn: options.queryFn,
		...(options.enabled === undefined ? {} : { enabled: options.enabled }),
		...(options.staleTime === undefined ? {} : { staleTime: options.staleTime }),
		...(options.retry === undefined ? {} : { retry: options.retry }),
		...(options.watch === undefined ? {} : { watch: options.watch }),
	}) as AnyQueryOptions<Context, Input, Value>
}

function normalizeMutationOptions<Descriptor, Context, Input extends readonly unknown[], Result>(
	options: WorkbenchRendererMutationOptions<Descriptor, Context, Input, Result>,
): WorkbenchRendererMutationOptions<Descriptor, Context, Input, Result> {
	if (!options || typeof options !== 'object' || typeof options.mutationFn !== 'function') {
		throw new TypeError('[workbench/react] mutation() requires mutationFn')
	}
	if ('workbench' in options) {
		throw new TypeError('[workbench/react] mutation options do not support a workbench namespace')
	}
	const invalidates = options.invalidates
	if (
		invalidates !== undefined &&
		typeof invalidates !== 'function' &&
		!Array.isArray(invalidates)
	) {
		throw new TypeError('[workbench/react] mutation invalidates must be an array or function')
	}
	const normalizedInvalidates = Array.isArray(invalidates)
		? Object.freeze([...invalidates])
		: invalidates
	return Object.freeze({
		mutationFn: options.mutationFn,
		...(normalizedInvalidates === undefined ? {} : { invalidates: normalizedInvalidates }),
	})
}

function readEnabled<Context, Input, Value>(
	options: AnyQueryOptions<Context, Input, Value>,
	input: Input,
): boolean {
	const enabled = options.enabled
	const result = typeof enabled === 'function' ? enabled(input) : enabled !== false
	if (typeof result !== 'boolean') {
		throw new TypeError('[workbench/react] query enabled predicate must return a boolean')
	}
	return result
}

function getQueryFn(options: AnyQueryOptions<any, any, any>): (...input: any[]) => unknown {
	return options.queryFn as (...input: any[]) => unknown
}

function getWatch(
	options: AnyQueryOptions<any, any, any>,
): ((...input: any[]) => unknown) | undefined {
	return options.watch as ((...input: any[]) => unknown) | undefined
}

function getStaleTime(options: AnyQueryOptions<any, any, any>, watched: boolean): number {
	return options.staleTime ?? (watched ? Infinity : 0)
}

function executionContext<Context>(
	context: Context,
	signal: AbortSignal,
): WorkbenchQueryExecutionContext<Context> {
	return Object.freeze({ ...context, signal }) as WorkbenchQueryExecutionContext<Context>
}

function createInvalidationTarget<Descriptor extends WorkbenchRenderableDescriptor>(
	scope: ScopeState<Descriptor>,
	resource: object,
	cacheKey: string | null,
	all: boolean,
): WorkbenchQueryInvalidation<Descriptor> {
	const target = Object.freeze({})
	invalidationMetadata.set(
		target,
		Object.freeze({ scopeToken: scope.token, resource, cacheKey, all }),
	)
	return target as WorkbenchQueryInvalidation<Descriptor>
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
				if (!descriptor || !('value' in descriptor)) keyInvalid()
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
			if (!descriptor || !('value' in descriptor)) keyInvalid()
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

function callSafely(listener: () => void): void {
	try {
		listener()
	} catch {
		// These callbacks are framework-owned notifications. One faulty listener must not interrupt
		// owner teardown or prevent the remaining React subscribers from observing the new snapshot.
	}
}
