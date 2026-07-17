import type { BuiltinDocContent } from './document-contracts'

export const WorkbenchSlots = {
	GlobalHeaderActions: 'global.headerActions',
	GlobalNavbarItems: 'global.navbarItems',
	GlobalNavbarFooter: 'global.navbarFooter',
	GlobalStatusBar: 'global.statusBar',
	PluginHeader: 'plugin.header',
	PluginTabs: 'plugin.tabs',
	PluginActions: 'plugin.actions',
	PluginContext: 'plugin.context',
	PluginInfo: 'plugin.info',
	PluginDock: 'plugin.dock',
	PluginCapabilities: 'plugin.capabilities',
} as const

export const WorkbenchIcons = {
	Api: 'api',
	BrandDiscord: 'brand-discord',
	BrandTelegram: 'brand-telegram',
	Building: 'building',
	ChartBar: 'chart-bar',
	CloudUpload: 'cloud-upload',
	History: 'history',
	MessageChatbot: 'message-chatbot',
	PlugConnected: 'plug-connected',
	Receipt: 'receipt',
	Search: 'search',
	Settings: 'settings',
	ShieldLock: 'shield-lock',
	TestPipe: 'test-pipe',
	TextRecognition: 'text-recognition',
	Typography: 'typography',
	Users: 'users',
} as const

export type WorkbenchIcon = (typeof WorkbenchIcons)[keyof typeof WorkbenchIcons]
export type WorkbenchSlot = (typeof WorkbenchSlots)[keyof typeof WorkbenchSlots]
export type WorkbenchPlacement = WorkbenchSlot | 'plugin.routes'
export type WorkbenchAudience = { readonly kind: 'self' } | { readonly kind: 'requiredDependents' }

export type WorkbenchViewRef =
	| { readonly kind: 'remote'; readonly export: string }
	| {
			readonly kind: 'builtin'
			readonly renderer: 'document'
			readonly props: Readonly<Record<string, unknown>>
	  }

export type WorkbenchViewMeta = Readonly<{
	label?: string
	icon?: WorkbenchIcon
	tab?: Readonly<{ id: string; label: string; icon?: WorkbenchIcon }>
	route?: Readonly<{
		path: string
		title: string
		icon?: WorkbenchIcon
		addToNav?: boolean
		navPriority?: number
		frame?: 'shell' | 'standalone'
	}>
}>

export type WorkbenchPlacementSpec = Readonly<{
	placement: WorkbenchPlacement
	audience: WorkbenchAudience
	priority?: number
	when?: 'always' | 'running'
	meta?: WorkbenchViewMeta
}>

declare const workbenchResourceType: unique symbol

export type WorkbenchRpcResource<TRpc> = Readonly<{
	kind: 'rpc'
	readonly [workbenchResourceType]?: TRpc
}>

export type StandardSchema<Input = unknown, Output = Input> = Readonly<{
	'~standard': Readonly<{
		version: 1
		vendor: string
		validate(
			value: unknown,
		):
			| { value: Output; issues?: undefined }
			| { value?: undefined; issues: readonly unknown[] }
			| Promise<
					{ value: Output; issues?: undefined } | { value?: undefined; issues: readonly unknown[] }
			  >
	}>
}>

export type WorkbenchLiveQueryResource<Params, Row> = Readonly<{
	kind: 'liveQuery'
	params?: StandardSchema<any, Params>
	row: StandardSchema<any, Row>
	key: keyof Row & string
	readonly [workbenchResourceType]?: { params: Params; row: Row }
}>

export type WorkbenchEventsResource<TEvents extends Record<string, unknown>> = Readonly<{
	kind: 'events'
	readonly [workbenchResourceType]?: TEvents
}>

export type WorkbenchResourceContract =
	| WorkbenchRpcResource<unknown>
	| WorkbenchLiveQueryResource<unknown, Record<string, unknown>>
	| WorkbenchEventsResource<Record<string, unknown>>

export type WorkbenchResourceMap = Readonly<Record<string, WorkbenchResourceContract>>

export type WorkbenchRpcOf<Resource> =
	Resource extends WorkbenchRpcResource<infer TRpc> ? TRpc : never
export type WorkbenchEventsOf<Resource> =
	Resource extends WorkbenchEventsResource<infer TEvents> ? TEvents : never
export type WorkbenchLiveQueryOf<Resource> =
	Resource extends WorkbenchLiveQueryResource<infer Params, infer Row>
		? { params: Params; row: Row }
		: never

export type WorkbenchLiveQuerySnapshot<Row> = Readonly<{
	generation: string
	revision: number
	rows: readonly Row[]
}>

export type WorkbenchLiveQueryPatch<Row, Key extends string | number = string | number> = Readonly<{
	generation: string
	fromRevision: number
	toRevision: number
	upserted: readonly Row[]
	removed: readonly Key[]
	order: readonly Key[]
}>

/** Browser-side RPC facade: only methods cross the boundary and every result is async. */
export type WorkbenchRpcClient<TRpc> = Readonly<{
	[Key in keyof TRpc as TRpc[Key] extends (...args: any[]) => any
		? Key
		: never]: TRpc[Key] extends (...args: infer Args) => infer Result
		? (...args: Args) => Promise<Awaited<Result>>
		: never
}>

export type WorkbenchPortContract<Resources extends WorkbenchResourceMap = WorkbenchResourceMap> =
	Readonly<{
		id: string
		version: number
		resources: Resources
	}>

export type WorkbenchViewSpec<
	AcceptedResources extends WorkbenchResourceMap = Readonly<Record<never, never>>,
> = Readonly<{
	kind: 'view'
	view?: Extract<WorkbenchViewRef, { kind: 'builtin' }>
	placements: readonly WorkbenchPlacementSpec[]
	accepts?: WorkbenchPortContract<AcceptedResources>
}>

export type WorkbenchViewMap = Readonly<Record<string, WorkbenchViewSpec<any>>>

export type WorkbenchPortOutlet = Readonly<{
	kind: 'port'
	id: string
	placement: WorkbenchSlot
	port: WorkbenchPortContract<any>
	priority?: number
	when?: 'always' | 'running'
	meta?: WorkbenchViewMeta
	provide: Readonly<Record<string, string>>
}>

export type WorkbenchPortRenderer = Readonly<{
	kind: 'port-renderer'
	id: string
	port: WorkbenchPortContract<any>
	viewId: string
}>

export type WorkbenchPortContribution = WorkbenchPortOutlet | WorkbenchPortRenderer

export type WorkbenchContract<
	Resources extends WorkbenchResourceMap = WorkbenchResourceMap,
	Views extends WorkbenchViewMap = WorkbenchViewMap,
> = Readonly<{
	fingerprint: string
	resources: Resources
	views: Views
	ports: readonly WorkbenchPortContribution[]
}>

export type AnyWorkbenchContract = WorkbenchContract<any, any>

export type WorkbenchResourceToken<
	Key extends string = string,
	Resource extends WorkbenchResourceContract = WorkbenchResourceContract,
> = Readonly<{
	key: Key
	readonly contract?: Resource
}>

export type WorkbenchResourceTokens<Resources extends WorkbenchResourceMap> = Readonly<{
	[Key in keyof Resources & string]: WorkbenchResourceToken<Key, Resources[Key]>
}>

type WorkbenchViewInput<Port extends WorkbenchPortContract<any> | undefined = undefined> =
	Readonly<{
		placements?: readonly WorkbenchPlacementSpec[]
		accepts?: Port
	}>

type WorkbenchDocumentInput = Readonly<{
	placements: readonly WorkbenchPlacementSpec[]
	title?: string
	description?: string
	content: BuiltinDocContent
}>

type PortResourcesOf<Port> =
	Port extends WorkbenchPortContract<infer Resources> ? Resources : Readonly<Record<never, never>>

type NormalizedView<Input> =
	Input extends WorkbenchViewSpec<any>
		? Input
		: Input extends { accepts?: infer Port }
			? WorkbenchViewSpec<PortResourcesOf<Port>>
			: WorkbenchViewSpec

type NormalizedViews<Views extends Readonly<Record<string, unknown>>> = Readonly<{
	[Key in keyof Views]: NormalizedView<Views[Key]>
}>

type PortProvide<Port extends WorkbenchPortContract<any>> = {
	[Key in keyof Port['resources'] & string]: WorkbenchResourceToken<string, Port['resources'][Key]>
}

type WorkbenchOutletInput<Port extends WorkbenchPortContract<any>> = Readonly<{
	port: Port
	placement: WorkbenchPlacementSpec
	provide: PortProvide<Port>
}>

type WorkbenchOutletMap = Readonly<Record<string, WorkbenchOutletInput<any>>>

function defineContract<
	const Resources extends WorkbenchResourceMap = Readonly<Record<never, never>>,
	const Views extends Readonly<Record<string, WorkbenchViewInput<any> | WorkbenchViewSpec<any>>> =
		Readonly<Record<never, never>>,
>(input: {
	resources?: Resources
	views?: Views
	outlets?: (input: { resources: WorkbenchResourceTokens<Resources> }) => WorkbenchOutletMap
}): WorkbenchContract<Resources, NormalizedViews<Views>> {
	const resources = Object.freeze({ ...input.resources }) as Resources
	const tokens = Object.freeze(
		Object.fromEntries(Object.keys(resources).map((key) => [key, Object.freeze({ key })])),
	) as WorkbenchResourceTokens<Resources>
	const views = Object.freeze(
		Object.fromEntries(
			Object.entries(input.views ?? {}).map(([viewId, raw]) => {
				requiredText('workbenchContract.define', 'view id', viewId)
				const view = raw as WorkbenchViewInput<any> | WorkbenchViewSpec<any>
				const placements = normalizePlacements(view.placements ?? [], Boolean(view.accepts))
				return [viewId, Object.freeze({ ...view, kind: 'view', placements })]
			}),
		),
	) as NormalizedViews<Views>

	const ports: WorkbenchPortContribution[] = []
	for (const [outletId, outlet] of Object.entries(input.outlets?.({ resources: tokens }) ?? {})) {
		const placement = outlet.placement
		if (!placement || placement.placement === 'plugin.routes') {
			throw new Error(
				`[workbench-contract] outlets.${outletId}.placement must be a typed slot placement`,
			)
		}
		const provided = Object.fromEntries(
			Object.entries(outlet.provide).map(([key, token]) => [
				key,
				(token as WorkbenchResourceToken).key,
			]),
		)
		const expectedKeys = Object.keys(outlet.port.resources).sort()
		const actualKeys = Object.keys(provided).sort()
		if (expectedKeys.join('\0') !== actualKeys.join('\0')) {
			throw new Error(
				`[workbench-contract] outlets.${outletId}.provide must map every Port resource`,
			)
		}
		ports.push(
			Object.freeze({
				kind: 'port',
				id: requiredText('workbenchContract.define', 'outlet id', outletId),
				placement: placement.placement,
				port: outlet.port,
				priority: placement.priority,
				when: placement.when,
				meta: placement.meta,
				provide: Object.freeze(provided),
			}),
		)
	}
	const renderedPorts = new Set<string>()
	for (const [viewId, view] of Object.entries(views)) {
		if (!view.accepts) continue
		const key = `${view.accepts.id}\0${view.accepts.version}`
		if (renderedPorts.has(key)) {
			throw new Error(`[workbench-contract] multiple Views accept Port "${view.accepts.id}"`)
		}
		renderedPorts.add(key)
		ports.push(Object.freeze({ kind: 'port-renderer', id: viewId, port: view.accepts, viewId }))
	}
	const frozenPorts = Object.freeze(ports)
	return Object.freeze({
		fingerprint: contractFingerprint({ resources, views, ports: frozenPorts }),
		resources,
		views,
		ports: frozenPorts,
	})
}

function rpcResource<TRpc>(): WorkbenchRpcResource<TRpc> {
	return Object.freeze({ kind: 'rpc' }) as WorkbenchRpcResource<TRpc>
}

function liveQueryResource<Row>(input: {
	row: StandardSchema<any, Row>
	key: keyof Row & string
}): WorkbenchLiveQueryResource<undefined, Row>
function liveQueryResource<Params, Row>(input: {
	params: StandardSchema<any, Params>
	row: StandardSchema<any, Row>
	key: keyof Row & string
}): WorkbenchLiveQueryResource<Params, Row>
function liveQueryResource<Params, Row>(input: {
	params?: StandardSchema<any, Params>
	row: StandardSchema<any, Row>
	key: keyof Row & string
}): WorkbenchLiveQueryResource<Params, Row> {
	if (!input?.row?.['~standard']) {
		throw new TypeError('[workbench-contract] liveQuery.row must implement Standard Schema V1')
	}
	if (input.params && !input.params['~standard']) {
		throw new TypeError('[workbench-contract] liveQuery.params must implement Standard Schema V1')
	}
	if (!String(input.key ?? '').trim()) {
		throw new TypeError('[workbench-contract] liveQuery.key is required')
	}
	return Object.freeze({ kind: 'liveQuery', params: input.params, row: input.row, key: input.key })
}

function eventsResource<
	TEvents extends Record<string, unknown>,
>(): WorkbenchEventsResource<TEvents> {
	return Object.freeze({ kind: 'events' }) as WorkbenchEventsResource<TEvents>
}

function portContract<const Resources extends WorkbenchResourceMap>(input: {
	id: string
	version?: number
	resources: Resources
}): WorkbenchPortContract<Resources> {
	const version = input.version ?? 1
	if (!Number.isInteger(version) || version <= 0) {
		throw new Error('[workbench-contract] port.version must be a positive integer')
	}
	return Object.freeze({
		id: requiredText('workbenchContract.port', 'id', input.id),
		version,
		resources: Object.freeze({ ...input.resources }),
	})
}

function slotPlacement(
	slot: WorkbenchSlot,
	input: {
		label?: string
		icon?: WorkbenchIcon
		tab?: { id: string; label: string; icon?: WorkbenchIcon }
		order?: number
		when?: 'always' | 'running'
		audience?: WorkbenchAudience
	} = {},
): WorkbenchPlacementSpec {
	return Object.freeze({
		placement: slot,
		audience: input.audience ?? Object.freeze({ kind: 'self' as const }),
		priority: -(input.order ?? 0),
		when: input.when,
		meta: Object.freeze({ label: input.label, icon: input.icon, tab: input.tab }),
	})
}

function routePlacement(
	path: string,
	input: {
		title: string
		icon?: WorkbenchIcon
		navigation?: boolean
		frame?: 'shell' | 'standalone'
		order?: number
		when?: 'always' | 'running'
	},
): WorkbenchPlacementSpec {
	const order = input.order ?? 0
	return Object.freeze({
		placement: 'plugin.routes',
		audience: Object.freeze({ kind: 'self' as const }),
		priority: -order,
		when: input.when,
		meta: Object.freeze({
			route: Object.freeze({
				path: requiredText('workbenchContract.route', 'path', path),
				title: requiredText('workbenchContract.route', 'title', input.title),
				icon: input.icon,
				addToNav: input.navigation !== false,
				navPriority: -order,
				frame: input.frame,
			}),
		}),
	})
}

function documentView(
	input: WorkbenchDocumentInput,
): WorkbenchViewSpec & Readonly<{ view: Extract<WorkbenchViewRef, { kind: 'builtin' }> }> {
	return Object.freeze({
		kind: 'view',
		placements: normalizePlacements(input.placements, false),
		view: Object.freeze({
			kind: 'builtin',
			renderer: 'document',
			props: Object.freeze({
				title: input.title,
				description: input.description,
				content: input.content,
			}),
		}),
	})
}

function normalizePlacements(
	placements: readonly WorkbenchPlacementSpec[],
	allowEmpty: boolean,
): readonly WorkbenchPlacementSpec[] {
	if (!Array.isArray(placements) || (!allowEmpty && placements.length === 0)) {
		throw new Error('[workbench-contract] View requires at least one placement')
	}
	const identities = new Set<string>()
	for (const placement of placements) {
		const route = placement.meta?.route?.path
		const identity = route ? `route:${normalizeRoutePath(route)}` : `slot:${placement.placement}`
		if (identities.has(identity)) {
			throw new Error(`[workbench-contract] View has duplicate placement "${identity}"`)
		}
		identities.add(identity)
	}
	return Object.freeze([...placements])
}

function normalizeRoutePath(path: string): string {
	const value = requiredText('workbenchContract.route', 'path', path)
	return `/${value.replaceAll(/^\/+|\/+$/g, '')}`
}

function requiredText(api: string, field: string, value: string): string {
	const normalized = String(value ?? '').trim()
	if (!normalized) throw new Error(`[workbench-contract] ${api}(): ${field} required`)
	return normalized
}

function contractFingerprint(value: unknown): string {
	const input = stableStringify(value)
	let hash = 2166136261
	for (let index = 0; index < input.length; index += 1) {
		hash ^= input.charCodeAt(index)
		hash = Math.imul(hash, 16777619)
	}
	return `wbc-${(hash >>> 0).toString(36)}`
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	return `{${Object.entries(value as Record<string, unknown>)
		.filter(([, item]) => item !== undefined)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
		.join(',')}}`
}

export const workbenchContract = Object.freeze({
	define: defineContract,
	rpc: rpcResource,
	liveQuery: liveQueryResource,
	events: eventsResource,
	port: portContract,
	slot: slotPlacement,
	route: routePlacement,
	document: documentView,
	slots: WorkbenchSlots,
	icons: WorkbenchIcons,
	audience: Object.freeze({
		self: Object.freeze({ kind: 'self' as const }),
		requiredDependents: Object.freeze({ kind: 'requiredDependents' as const }),
	}),
})

export type WorkbenchResourceRef = Readonly<{
	grantId: string
	kind: WorkbenchResourceContract['kind']
}>

export type WorkbenchLayoutItem = Readonly<{
	id: string
	viewId: string
	ownerPluginId: string
	targetPluginId: string
	contractFingerprint: string
	placement: WorkbenchPlacement
	view: WorkbenchViewRef
	priority: number
	when: 'always' | 'running'
	meta?: WorkbenchViewMeta
	/** @internal Opaque granted resources consumed by the host and browser UI runtime. */
	model: Readonly<Record<string, WorkbenchResourceRef>>
	/** @internal Target-scoped resources injected into a cross-plugin renderer. */
	port?: Readonly<{
		id: string
		version: number
		model: Readonly<Record<string, WorkbenchResourceRef>>
	}>
}>

export type WorkbenchLayout = Readonly<{
	revision: number
	targetPluginId: string | null
	items: readonly WorkbenchLayoutItem[]
}>

export type WorkbenchBundle = Readonly<{
	pluginName: string
	remoteName: string
	manifestUrl: string
	exposedModule: string
	sourceHash: string
	compiledAt: number
}>

export type WorkbenchBundleState = Readonly<{
	pluginName: string
	state: 'building' | 'ready' | 'error'
	updatedAt: number
	sourceHash?: string
	compiledAt?: number
	message?: string
}>

export type WorkbenchBundleEvent =
	| Readonly<{ type: 'sync'; revision: number }>
	| Readonly<{
			type: 'building' | 'error'
			revision: number
			pluginName: string
			updatedAt: number
			sourceHash?: string
			compiledAt?: number
			message?: string
	  }>
	| Readonly<{
			type: 'update'
			revision: number
			pluginName: string
			remoteName: string
			manifestUrl: string
			exposedModule: string
			sourceHash: string
			compiledAt: number
	  }>
	| Readonly<{ type: 'remove'; revision: number; pluginName: string }>

export type WorkbenchCatalog = Readonly<{
	revision: number
	bundles: readonly WorkbenchBundle[]
	states: readonly WorkbenchBundleState[]
}>
