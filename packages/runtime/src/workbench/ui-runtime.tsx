import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useSyncExternalStore,
	type ComponentType,
	type ReactNode,
} from 'react'
import type {
	AnyWorkbenchContract,
	WorkbenchEventsOf,
	WorkbenchLiveQueryOf,
	WorkbenchLiveQueryPatch,
	WorkbenchLiveQueryResource,
	WorkbenchLiveQuerySnapshot,
	WorkbenchLayoutItem,
	WorkbenchPortContract,
	WorkbenchResourceMap,
	WorkbenchResourceRef,
	WorkbenchRpcClient,
	WorkbenchRpcOf,
} from './contracts'
import { useGlobalExtensionContext, type ExtensionServices } from '../web/host-ui'
import type { SseClientWithNamespaces, SseMessage } from '../web/sse'

const WorkbenchViewContext = createContext<WorkbenchLayoutItem | null>(null)

export function WorkbenchViewProvider({
	item,
	children,
}: {
	item: WorkbenchLayoutItem
	children: ReactNode
}) {
	return <WorkbenchViewContext.Provider value={item}>{children}</WorkbenchViewContext.Provider>
}

export function useWorkbenchView(): WorkbenchLayoutItem {
	const value = useContext(WorkbenchViewContext)
	if (!value) throw new Error('useWorkbenchView() requires a WorkbenchViewProvider')
	return value
}

export type WorkbenchLiveQueryResult<Row> =
	| Readonly<{ state: 'loading'; rows: readonly Row[]; error: null; revision: number }>
	| Readonly<{ state: 'ready'; rows: readonly Row[]; error: null; revision: number }>
	| Readonly<{ state: 'stale'; rows: readonly Row[]; error: Error; revision: number }>
	| Readonly<{ state: 'error'; rows: readonly Row[]; error: Error; revision: number }>

type LiveQueryArgs<Params> = [Params] extends [undefined] ? [] | [undefined] : [Params]
type LiveQuerySubscribeArgs<Params> = [Params] extends [undefined]
	? [listener: () => void]
	: [params: Params, listener: () => void]

export interface WorkbenchLiveQueryClient<Params, Row> {
	useQuery(...args: LiveQueryArgs<Params>): WorkbenchLiveQueryResult<Row>
	getSnapshot(...args: LiveQueryArgs<Params>): WorkbenchLiveQueryResult<Row>
	subscribe(...args: LiveQuerySubscribeArgs<Params>): () => void
	refresh(...args: LiveQueryArgs<Params>): Promise<void>
}

export type WorkbenchEventConnectionState = Readonly<{
	state: 'connecting' | 'connected' | 'error'
	error: Error | null
}>

export interface WorkbenchEventsClient<TEvents extends Record<string, unknown>> {
	subscribe<Key extends keyof TEvents & string>(
		event: Key,
		listener: (payload: TEvents[Key]) => void,
	): () => void
	useConnectionState(): WorkbenchEventConnectionState
}

export type WorkbenchResourceClient<Resource> = Resource extends { kind: 'rpc' }
	? WorkbenchRpcClient<WorkbenchRpcOf<Resource>>
	: Resource extends WorkbenchLiveQueryResource<any, any>
		? WorkbenchLiveQueryClient<
				WorkbenchLiveQueryOf<Resource>['params'],
				WorkbenchLiveQueryOf<Resource>['row']
			>
		: Resource extends { kind: 'events' }
			? WorkbenchEventsClient<WorkbenchEventsOf<Resource>>
			: never

export type WorkbenchResourceClients<Resources extends WorkbenchResourceMap> = Readonly<{
	[Key in keyof Resources]: WorkbenchResourceClient<Resources[Key]>
}>

export type WorkbenchHost = Readonly<{
	ownerPluginId: string
	targetPluginId: string
	colorScheme: 'light' | 'dark'
	locale: string
	notify: ExtensionServices['ui']['notify']
	confirm: ExtensionServices['ui']['confirm']
}>

export function useWorkbenchHost(): WorkbenchHost {
	const item = useWorkbenchView()
	const context = useGlobalExtensionContext()
	const locale = useSyncExternalStore(
		(listener) => context.services.locale.subscribe(listener),
		() => context.services.locale.locale,
		() => context.services.locale.locale,
	)
	return useMemo(
		() => ({
			ownerPluginId: item.ownerPluginId,
			targetPluginId: item.targetPluginId,
			colorScheme: context.colorScheme,
			locale,
			notify: context.services.ui.notify,
			confirm: context.services.ui.confirm,
		}),
		[context, item.ownerPluginId, item.targetPluginId, locale],
	)
}

export type WorkbenchViewComponent = ComponentType

export type WorkbenchUiModule = Readonly<{
	contractFingerprint: string
	views: Readonly<Record<string, WorkbenchViewComponent>>
	setup?: (ctx: {
		ownerPluginId: string
		locale: ExtensionServices['locale']
	}) => void | (() => void) | Promise<void | (() => void)>
}>

type RemoteViewKeys<Contract extends AnyWorkbenchContract> = {
	[Key in keyof Contract['views'] & string]: Contract['views'][Key] extends {
		view: { kind: 'builtin' }
	}
		? never
		: Key
}[keyof Contract['views'] & string]

export interface WorkbenchUiDefinition<Contract extends AnyWorkbenchContract> {
	useResources(): WorkbenchResourceClients<Contract['resources']>
	usePort<Port extends WorkbenchPortContract<any>>(
		port: Port,
	): WorkbenchResourceClients<Port['resources']>
	define<const Views extends Readonly<Record<RemoteViewKeys<Contract>, ComponentType>>>(
		views: Views & Readonly<Record<Exclude<keyof Views, RemoteViewKeys<Contract>>, never>>,
		options?: Omit<WorkbenchUiModule, 'views' | 'contractFingerprint'>,
	): Readonly<{ views: Views } & Omit<WorkbenchUiModule, 'views'>>
}

export function createWorkbenchUi<const Contract extends AnyWorkbenchContract>(
	contract: Contract,
): WorkbenchUiDefinition<Contract> {
	if (!contract || typeof contract !== 'object') {
		throw new Error('[workbench-ui] createWorkbenchUi(): Contract value required')
	}
	return Object.freeze({
		useResources() {
			const item = useWorkbenchView()
			return useGrantedResources<Contract['resources']>(item.model, contract.resources)
		},
		usePort<Port extends WorkbenchPortContract<any>>(port: Port) {
			const item = useWorkbenchView()
			if (!item.port || item.port.id !== port.id || item.port.version !== port.version) {
				throw new Error(
					`[workbench-ui] current View does not accept Port "${port.id}" v${port.version}`,
				)
			}
			return useGrantedResources<Port['resources']>(item.port.model, port.resources)
		},
		define<const Views extends Readonly<Record<RemoteViewKeys<Contract>, ComponentType>>>(
			components: Views & Readonly<Record<Exclude<keyof Views, RemoteViewKeys<Contract>>, never>>,
			options: Omit<WorkbenchUiModule, 'views' | 'contractFingerprint'> = {},
		) {
			if (!components || typeof components !== 'object') {
				throw new Error('[workbench-ui] createWorkbenchUi().define(): views required')
			}
			const expected = (
				Object.entries(contract.views) as Array<
					[string, Contract['views'][keyof Contract['views']]]
				>
			)
				.filter(([, view]) => view.view?.kind !== 'builtin')
				.map(([viewId]) => viewId)
				.sort()
			const actual = Object.keys(components).sort()
			if (expected.join('\0') !== actual.join('\0')) {
				throw new Error(
					`[workbench-ui] View exports must exactly match Contract; expected ${expected.join(', ') || '<none>'}`,
				)
			}
			for (const [viewId, component] of Object.entries(components)) {
				if (!viewId.trim() || typeof component !== 'function') {
					throw new Error(`[workbench-ui] invalid View export: ${viewId || '<empty>'}`)
				}
			}
			return Object.freeze({
				...options,
				contractFingerprint: contract.fingerprint,
				views: Object.freeze({ ...components }),
			}) as never
		},
	})
}

function useGrantedResources<Resources extends WorkbenchResourceMap>(
	refs: Readonly<Record<string, WorkbenchResourceRef>>,
	contracts: Resources,
): WorkbenchResourceClients<Resources> {
	const item = useWorkbenchView()
	const context = useGlobalExtensionContext()
	const transport = context.services.transport
	const eventStreams = useMemo(() => new Map<string, SseClientWithNamespaces>(), [item, transport])
	useEffect(
		() => () => {
			for (const stream of eventStreams.values()) stream.close()
			eventStreams.clear()
		},
		[eventStreams],
	)

	return useMemo(() => {
		const resources: Record<string, unknown> = {}
		for (const [key, ref] of Object.entries(refs)) {
			const contract = contracts[key]
			switch (ref.kind) {
				case 'rpc':
					resources[key] = transport.workbench.rpc(ref.grantId)
					break
				case 'liveQuery':
					resources[key] = createLiveQueryClient(
						transport,
						ref.grantId,
						contract as WorkbenchLiveQueryResource<any, any>,
					)
					break
				case 'events':
					resources[key] = createEventsClient(() => {
						let stream = eventStreams.get(ref.grantId)
						if (!stream) {
							stream = transport.workbench.events(ref.grantId)
							eventStreams.set(ref.grantId, stream)
						}
						return stream
					})
					break
			}
		}
		return new Proxy(Object.freeze(resources), {
			get(target, property, receiver) {
				if (typeof property === 'string' && !(property in target)) {
					throw new Error(
						`[workbench-ui] View "${item.viewId}" was not granted resource "${property}"`,
					)
				}
				return Reflect.get(target, property, receiver)
			},
		}) as WorkbenchResourceClients<Resources>
	}, [contracts, eventStreams, item.viewId, refs, transport])
}

type BrowserLiveQueryState<Row> = WorkbenchLiveQueryResult<Row> & {
	generation?: string
}

class BrowserLiveQueryVariant<Row> {
	private state: BrowserLiveQueryState<Row> = Object.freeze({
		state: 'loading',
		rows: Object.freeze([]),
		error: null,
		revision: 0,
	})
	private readonly listeners = new Set<() => void>()
	private stream?: SseClientWithNamespaces
	private task: Promise<void> = Promise.resolve()

	constructor(
		private readonly transport: ExtensionServices['transport'],
		private readonly grantId: string,
		private readonly params: unknown,
		private readonly contract: WorkbenchLiveQueryResource<any, Row>,
	) {}

	getSnapshot = (): WorkbenchLiveQueryResult<Row> => this.state

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		if (this.listeners.size === 1) this.start()
		return () => {
			this.listeners.delete(listener)
			if (this.listeners.size === 0) this.stop()
		}
	}

	async refresh(): Promise<void> {
		const response = await this.transport.fetch(
			this.transport.links.workbenchLiveQuery(this.grantId, this.params),
			{ method: 'GET' },
		)
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { message?: string }
			throw new Error(body.message ?? `liveQuery refresh failed: HTTP ${response.status}`)
		}
		await this.applySnapshot((await response.json()) as WorkbenchLiveQuerySnapshot<Row>)
	}

	private start(): void {
		const params = new URLSearchParams()
		if (this.params !== undefined) params.set('params', JSON.stringify(this.params))
		const base = this.transport.links.workbenchModelEvents(this.grantId)
		const url = params.size > 0 ? `${base}?${params}` : base
		this.stream = this.transport.createSse({ url })
		this.stream.onAny((message) => {
			this.task = this.task
				.then(async () => {
					switch (message.event) {
						case 'snapshot':
							return await this.applySnapshot(message.payload as WorkbenchLiveQuerySnapshot<Row>)
						case 'patch':
							return await this.applyPatch(message.payload as WorkbenchLiveQueryPatch<Row>)
						case 'error':
							this.fail(new Error(String((message.payload as any)?.message ?? 'liveQuery failed')))
							return
					}
					return
				})
				.catch((error) => this.fail(error))
		})
		this.stream.onError(() => this.fail(new Error('liveQuery stream disconnected')))
	}

	private stop(): void {
		this.stream?.close()
		this.stream = undefined
	}

	private async applySnapshot(snapshot: WorkbenchLiveQuerySnapshot<Row>): Promise<void> {
		if (
			!snapshot ||
			typeof snapshot.generation !== 'string' ||
			!Number.isInteger(snapshot.revision)
		) {
			throw new TypeError('invalid liveQuery snapshot')
		}
		const rows = await this.validateRows(snapshot.rows)
		this.update({
			state: 'ready',
			rows,
			error: null,
			revision: snapshot.revision,
			generation: snapshot.generation,
		})
	}

	private async applyPatch(patch: WorkbenchLiveQueryPatch<Row>): Promise<void> {
		if (
			!patch ||
			!this.state.generation ||
			patch.generation !== this.state.generation ||
			patch.fromRevision !== this.state.revision ||
			!Number.isInteger(patch.fromRevision) ||
			!Number.isInteger(patch.toRevision) ||
			patch.toRevision !== patch.fromRevision + 1
		) {
			await this.refresh()
			return
		}
		try {
			if (!Array.isArray(patch.removed) || !Array.isArray(patch.order)) {
				throw new TypeError('liveQuery patch keys must be arrays')
			}
			if (
				patch.removed.some((key) => !isLiveQueryKey(key)) ||
				patch.order.some((key) => !isLiveQueryKey(key)) ||
				new Set(patch.removed).size !== patch.removed.length ||
				new Set(patch.order).size !== patch.order.length
			) {
				throw new TypeError('liveQuery patch contains invalid or duplicate keys')
			}
			const upserted = await this.validateRows(patch.upserted)
			const byKey = new Map<string | number, Row>()
			for (const row of this.state.rows) byKey.set((row as any)[this.contract.key], row)
			for (const key of patch.removed) byKey.delete(key)
			for (const row of upserted) byKey.set((row as any)[this.contract.key], row)
			if (patch.order.length !== byKey.size) {
				throw new Error('liveQuery patch order does not describe the complete result')
			}
			const rows = patch.order.map((key) => {
				const row = byKey.get(key)
				if (!row) throw new Error(`liveQuery patch references missing key "${key}"`)
				return row
			})
			this.update({
				state: 'ready',
				rows: Object.freeze(rows),
				error: null,
				revision: patch.toRevision,
				generation: patch.generation,
			})
		} catch {
			await this.refresh()
		}
	}

	private async validateRows(rows: readonly Row[]): Promise<readonly Row[]> {
		if (!Array.isArray(rows)) throw new TypeError('liveQuery rows must be an array')
		const result: Row[] = []
		const keys = new Set<string | number>()
		for (const raw of rows) {
			const validation = await this.contract.row['~standard'].validate(raw)
			if (validation.issues) throw new TypeError('liveQuery row validation failed')
			const row = validation.value
			const key = (row as any)?.[this.contract.key]
			if (
				(typeof key !== 'string' && (typeof key !== 'number' || !Number.isFinite(key))) ||
				keys.has(key)
			) {
				throw new TypeError('liveQuery row key is invalid or duplicated')
			}
			keys.add(key)
			result.push(Object.freeze(row as Row))
		}
		return Object.freeze(result)
	}

	private fail(error: unknown): void {
		const cause = error instanceof Error ? error : new Error(String(error))
		this.update({
			...this.state,
			state: this.state.rows.length > 0 ? 'stale' : 'error',
			error: cause,
		})
	}

	private update(state: BrowserLiveQueryState<Row>): void {
		this.state = Object.freeze(state)
		for (const listener of this.listeners) listener()
	}
}

export function createLiveQueryClient<Params, Row>(
	transport: ExtensionServices['transport'],
	grantId: string,
	contract: WorkbenchLiveQueryResource<Params, Row>,
): WorkbenchLiveQueryClient<Params, Row> {
	const variants = new Map<string, BrowserLiveQueryVariant<Row>>()
	const variant = (params: unknown) => {
		const key = stableLiveQueryParams(params)
		let current = variants.get(key)
		if (!current) {
			current = new BrowserLiveQueryVariant(transport, grantId, params, contract)
			variants.set(key, current)
		}
		return current
	}
	return Object.freeze({
		useQuery(...args: unknown[]) {
			const current = variant(args[0])
			return useSyncExternalStore(current.subscribe, current.getSnapshot, current.getSnapshot)
		},
		getSnapshot(...args: unknown[]) {
			return variant(args[0]).getSnapshot()
		},
		subscribe(...args: unknown[]) {
			const params = args.length === 1 ? undefined : args[0]
			const listener = args.at(-1) as () => void
			return variant(params).subscribe(listener)
		},
		refresh(...args: unknown[]) {
			return variant(args[0]).refresh()
		},
	}) as WorkbenchLiveQueryClient<Params, Row>
}

function isLiveQueryKey(value: unknown): value is string | number {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function stableLiveQueryParams(value: unknown): string {
	if (value === undefined) return 'undefined'
	if (Array.isArray(value)) return `[${value.map(stableLiveQueryParams).join(',')}]`
	if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, child]) => `${JSON.stringify(key)}:${stableLiveQueryParams(child)}`)
		.join(',')}}`
}

function createEventsClient<TEvents extends Record<string, unknown>>(
	getStream: () => SseClientWithNamespaces,
): WorkbenchEventsClient<TEvents> {
	let state: WorkbenchEventConnectionState = Object.freeze({ state: 'connecting', error: null })
	const listeners = new Set<() => void>()
	let observed = false
	const notify = (next: WorkbenchEventConnectionState) => {
		state = Object.freeze(next)
		for (const listener of listeners) listener()
	}
	const observe = () => {
		const stream = getStream()
		if (!observed) {
			observed = true
			stream.onOpen(() => notify({ state: 'connected', error: null }))
			stream.onError(() =>
				notify({ state: 'error', error: new Error('event stream disconnected') }),
			)
		}
		return stream
	}
	return Object.freeze({
		subscribe<Key extends keyof TEvents & string>(
			event: Key,
			listener: (payload: TEvents[Key]) => void,
		) {
			return observe().onAny((message: SseMessage<string>) => {
				if (message.event === event) listener(message.payload as TEvents[Key])
			})
		},
		useConnectionState() {
			return useSyncExternalStore(
				(listener) => {
					listeners.add(listener)
					observe()
					return () => listeners.delete(listener)
				},
				() => state,
				() => state,
			)
		},
	})
}
