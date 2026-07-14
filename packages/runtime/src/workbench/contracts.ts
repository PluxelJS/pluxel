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

export type WorkbenchSlot = (typeof WorkbenchSlots)[keyof typeof WorkbenchSlots]
export type WorkbenchPlacement = WorkbenchSlot | 'plugin.routes'

export type WorkbenchAudience = { readonly kind: 'self' } | { readonly kind: 'requiredDependents' }

export type WorkbenchViewRef =
	| { readonly kind: 'remote'; readonly export: string }
	| {
			readonly kind: 'builtin'
			readonly renderer: 'document' | 'form' | 'table' | 'action'
			readonly props: Readonly<Record<string, unknown>>
	  }

export type WorkbenchViewMeta = Readonly<{
	label?: string
	icon?: string
	tab?: Readonly<{ id: string; label: string; icon?: string }>
	route?: Readonly<{
		path: string
		title: string
		icon?: string
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

export type WorkbenchViewSpec<
	ModelKey extends string = string,
	AcceptedModels extends WorkbenchModelMap = Readonly<Record<never, never>>,
> = Readonly<{
	kind: 'view'
	view?: Extract<WorkbenchViewRef, { kind: 'builtin' }>
	model: readonly ModelKey[]
	placements: readonly WorkbenchPlacementSpec[]
	accepts?: WorkbenchPortContract<AcceptedModels>
}>

export type WorkbenchPortContract<Models extends WorkbenchModelMap = WorkbenchModelMap> = Readonly<{
	id: string
	version: number
	model: Models
}>

export type WorkbenchPortOutlet = Readonly<{
	kind: 'port'
	id: string
	placement: WorkbenchSlot
	port: WorkbenchPortContract<any>
	providers?: readonly string[]
	priority?: number
	when?: 'always' | 'running'
	meta?: WorkbenchViewMeta
	provide?: Readonly<Record<string, string>>
}>

export type WorkbenchPortRenderer = Readonly<{
	kind: 'port-renderer'
	id: string
	port: WorkbenchPortContract<any>
	viewId: string
}>

export type WorkbenchPortContribution = WorkbenchPortOutlet | WorkbenchPortRenderer

type WorkbenchPortOutletDefinition = Omit<WorkbenchPortOutlet, 'id'>

declare const workbenchModelType: unique symbol

export type WorkbenchRpcModel<TRpc> = Readonly<{
	kind: 'rpc'
	readonly [workbenchModelType]?: TRpc
}>

export type WorkbenchCollectionItem = Readonly<{ id: string }>

export type WorkbenchCollectionModel<TItem extends WorkbenchCollectionItem> = Readonly<{
	kind: 'collection'
	readonly [workbenchModelType]?: TItem
}>

export type WorkbenchEventsModel<TEvents extends Record<string, unknown>> = Readonly<{
	kind: 'events'
	readonly [workbenchModelType]?: TEvents
}>

export type WorkbenchModelContract =
	| WorkbenchRpcModel<unknown>
	| WorkbenchCollectionModel<WorkbenchCollectionItem>
	| WorkbenchEventsModel<Record<string, unknown>>

export type WorkbenchModelMap = Readonly<Record<string, WorkbenchModelContract>>

export type WorkbenchModelToken<
	Key extends string = string,
	Model extends WorkbenchModelContract = WorkbenchModelContract,
> = Readonly<{
	key: Key
	readonly contract?: Model
}>

export type WorkbenchModelTokens<Models extends WorkbenchModelMap> = Readonly<{
	[Key in keyof Models & string]: WorkbenchModelToken<Key, Models[Key]>
}>

export type WorkbenchUiEntry = Readonly<{ entryPath: string }>

export type WorkbenchExtension<
	Models extends WorkbenchModelMap = WorkbenchModelMap,
	Views extends Readonly<Record<string, WorkbenchViewSpec<any, any>>> = Readonly<
		Record<string, WorkbenchViewSpec<any, any>>
	>,
> = Readonly<{
	plugin: string
	entry?: WorkbenchUiEntry
	model: Models
	views: Views
	ports: readonly WorkbenchPortContribution[]
}>

export type AnyWorkbenchExtension = WorkbenchExtension<any, any>

export type WorkbenchRpcOf<Model> = Model extends WorkbenchRpcModel<infer TRpc> ? TRpc : never
export type WorkbenchCollectionOf<Model> =
	Model extends WorkbenchCollectionModel<infer TItem> ? TItem : never
export type WorkbenchEventsOf<Model> =
	Model extends WorkbenchEventsModel<infer TEvents> ? TEvents : never

/** Browser-side RPC facade: only methods cross the boundary and every result is async. */
export type WorkbenchRpcClient<TRpc> = Readonly<{
	[Key in keyof TRpc as TRpc[Key] extends (...args: any[]) => any
		? Key
		: never]: TRpc[Key] extends (...args: infer Args) => infer Result
		? (...args: Args) => Promise<Awaited<Result>>
		: never
}>

export type WorkbenchModelRef = Readonly<{
	grantId: string
	kind: WorkbenchModelContract['kind']
}>

export type WorkbenchLayoutItem = Readonly<{
	id: string
	viewId: string
	ownerPluginId: string
	targetPluginId: string
	placement: WorkbenchPlacement
	view: WorkbenchViewRef
	priority: number
	when: 'always' | 'running'
	meta?: WorkbenchViewMeta
	model: Readonly<Record<string, WorkbenchModelRef>>
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

function slotPlacement(input: {
	slot: WorkbenchSlot
	audience?: WorkbenchAudience
	label?: string
	icon?: string
	tab?: { id: string; label: string; icon?: string }
	priority?: number
	when?: 'always' | 'running'
}): WorkbenchPlacementSpec {
	return Object.freeze({
		placement: input.slot,
		audience: input.audience ?? Object.freeze({ kind: 'self' as const }),
		priority: input.priority,
		when: input.when,
		meta: Object.freeze({ label: input.label, icon: input.icon, tab: input.tab }),
	})
}

function routePlacement(input: {
	path: string
	title: string
	icon?: string
	navigation?: false | { priority?: number }
	frame?: 'shell' | 'standalone'
	priority?: number
	when?: 'always' | 'running'
}): WorkbenchPlacementSpec {
	return Object.freeze({
		placement: 'plugin.routes',
		audience: Object.freeze({ kind: 'self' as const }),
		priority: input.priority,
		when: input.when,
		meta: Object.freeze({
			route: Object.freeze({
				path: requiredText('workbench.place.route', 'path', input.path),
				title: requiredText('workbench.place.route', 'title', input.title),
				icon: input.icon,
				addToNav: input.navigation !== false && input.navigation !== undefined,
				navPriority: input.navigation === false ? undefined : input.navigation?.priority,
				frame: input.frame,
			}),
		}),
	})
}

type ModelKeyOf<Tokens extends readonly WorkbenchModelToken[]> =
	Tokens[number] extends WorkbenchModelToken<infer Key, any> ? Key : never

type ViewInput<Tokens extends readonly WorkbenchModelToken[]> = Readonly<{
	model?: Tokens
	placements: readonly WorkbenchPlacementSpec[]
}>

type AcceptedModelsOf<Port> =
	Port extends WorkbenchPortContract<infer Models> ? Models : Readonly<Record<never, never>>

function remoteView<const Port extends WorkbenchPortContract<any> | undefined = undefined>(
	input: Omit<ViewInput<readonly []>, 'model'> & { model?: undefined; accepts?: Port },
): WorkbenchViewSpec<never, AcceptedModelsOf<Port>>
function remoteView<
	const Tokens extends readonly WorkbenchModelToken[],
	const Port extends WorkbenchPortContract<any> | undefined = undefined,
>(
	input: ViewInput<Tokens> & { model: Tokens; accepts?: Port },
): WorkbenchViewSpec<ModelKeyOf<Tokens>, AcceptedModelsOf<Port>>
function remoteView(
	input: ViewInput<readonly WorkbenchModelToken[]> & {
		accepts?: WorkbenchPortContract<any>
	},
): WorkbenchViewSpec<string, any> {
	return Object.freeze({
		kind: 'view',
		model: selectedModelKeys(input.model),
		placements: normalizedPlacements(
			'workbench.view.remote',
			input.placements,
			Boolean(input.accepts),
		),
		accepts: input.accepts,
	})
}

type DocumentViewInput<Tokens extends readonly WorkbenchModelToken[]> = ViewInput<Tokens> & {
	title?: string
	description?: string
	content: BuiltinDocContent
}

function documentView(
	input: Omit<DocumentViewInput<readonly []>, 'model'> & { model?: undefined },
): WorkbenchViewSpec<never>
function documentView<const Tokens extends readonly WorkbenchModelToken[]>(
	input: DocumentViewInput<Tokens> & { model: Tokens },
): WorkbenchViewSpec<ModelKeyOf<Tokens>>
function documentView(
	input: DocumentViewInput<readonly WorkbenchModelToken[]>,
): WorkbenchViewSpec<string> {
	return Object.freeze({
		kind: 'view',
		model: selectedModelKeys(input.model),
		placements: normalizedPlacements('workbench.view.document', input.placements, false),
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

function defineExtension<
	const Models extends WorkbenchModelMap,
	const Views extends Readonly<
		Record<string, WorkbenchViewSpec<Extract<keyof Models, string>, any>>
	>,
>(input: {
	plugin: string
	entry?: WorkbenchUiEntry
	model?: Models
	views?: (model: WorkbenchModelTokens<Models>) => Views
	ports?: (
		model: WorkbenchModelTokens<Models>,
	) => Readonly<Record<string, WorkbenchPortOutletDefinition>>
}): WorkbenchExtension<Models, Views> {
	const plugin = requiredText('workbench.define', 'plugin', input.plugin)
	const model = Object.freeze({ ...input.model }) as Models
	const modelTokens = Object.freeze(
		Object.fromEntries(Object.keys(model).map((key) => [key, Object.freeze({ key })])),
	) as WorkbenchModelTokens<Models>
	const views = Object.freeze({ ...input.views?.(modelTokens) }) as Views
	for (const [viewId, view] of Object.entries(views)) {
		requiredText('workbench.define', 'view id', viewId)
		if (view.placements.length === 0 && !view.accepts) {
			throw new Error(`[workbench] view "${viewId}" requires at least one placement`)
		}
		for (const key of view.model) {
			if (!(key in model)) {
				throw new Error(`[workbench] view "${viewId}" selects unknown model "${key}"`)
			}
		}
	}
	const ports: WorkbenchPortContribution[] = []
	for (const [id, outlet] of Object.entries(input.ports?.(modelTokens) ?? {})) {
		ports.push(Object.freeze({ ...outlet, id: requiredText('workbench.define', 'port id', id) }))
	}
	for (const [viewId, view] of Object.entries(views)) {
		if (!view.accepts) continue
		ports.push(
			Object.freeze({
				kind: 'port-renderer',
				id: viewId,
				port: view.accepts,
				viewId,
			}),
		)
	}
	return Object.freeze({
		plugin,
		entry: input.entry,
		model,
		views,
		ports: Object.freeze(ports),
	})
}

function definePort<const Models extends WorkbenchModelMap>(
	id: string,
	model: Models,
	version = 1,
): WorkbenchPortContract<Models> {
	if (!Number.isInteger(version) || version <= 0) {
		throw new Error('[workbench] workbench.port.define(): version must be a positive integer')
	}
	return Object.freeze({
		id: requiredText('workbench.port.define', 'id', id),
		version,
		model: Object.freeze({ ...model }),
	})
}

type PortProvide<Port extends WorkbenchPortContract<any>> = Partial<{
	[Key in keyof Port['model'] & string]: WorkbenchModelToken<string, Port['model'][Key]>
}>

function portOutlet<const Port extends WorkbenchPortContract<any>>(
	input: Omit<WorkbenchPortOutlet, 'kind' | 'id' | 'port' | 'provide'> & {
		port: Port
		provide?: PortProvide<Port>
	},
): WorkbenchPortOutletDefinition {
	return Object.freeze({
		...input,
		kind: 'port',
		provide: Object.freeze(
			Object.fromEntries(
				Object.entries(input.provide ?? {}).map(([key, token]) => [
					key,
					(token as WorkbenchModelToken).key,
				]),
			),
		),
	})
}

/** @internal Public authoring namespace is assembled in ../workbench.ts. */
export const workbenchDefinition = Object.freeze({
	define: defineExtension,
	entry(moduleUrl: string | URL, entryPath: string): WorkbenchUiEntry {
		const url = new URL(requiredText('workbench.entry', 'entry path', entryPath), moduleUrl)
		if (url.protocol !== 'file:') {
			throw new Error('[workbench] workbench.entry(): module URL must use the file protocol')
		}
		let path = decodeURIComponent(url.pathname)
		if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
		return Object.freeze({ entryPath: path })
	},
	model: Object.freeze({
		rpc<TRpc>(): WorkbenchRpcModel<TRpc> {
			return Object.freeze({ kind: 'rpc' }) as WorkbenchRpcModel<TRpc>
		},
		collection<TItem extends WorkbenchCollectionItem>(): WorkbenchCollectionModel<TItem> {
			return Object.freeze({ kind: 'collection' }) as WorkbenchCollectionModel<TItem>
		},
		events<TEvents extends Record<string, unknown>>(): WorkbenchEventsModel<TEvents> {
			return Object.freeze({ kind: 'events' }) as WorkbenchEventsModel<TEvents>
		},
	}),
	view: Object.freeze({ remote: remoteView, document: documentView }),
	place: Object.freeze({ slot: slotPlacement, route: routePlacement }),
	slot: WorkbenchSlots,
	audience: Object.freeze({
		self: Object.freeze({ kind: 'self' as const }),
		requiredDependents: Object.freeze({ kind: 'requiredDependents' as const }),
	}),
	port: Object.freeze({ define: definePort, outlet: portOutlet }),
})

function selectedModelKeys<const Tokens extends readonly WorkbenchModelToken[]>(
	model: Tokens | undefined,
): readonly ModelKeyOf<Tokens>[] {
	return Object.freeze(
		(model ?? []).map((token) => requiredText('workbench.view', 'model key', token.key)),
	) as readonly ModelKeyOf<Tokens>[]
}

function normalizedPlacements(
	api: string,
	placements: readonly WorkbenchPlacementSpec[],
	allowEmpty: boolean,
): readonly WorkbenchPlacementSpec[] {
	if (!Array.isArray(placements) || (!allowEmpty && placements.length === 0)) {
		throw new Error(`[workbench] ${api}(): placements required`)
	}
	return Object.freeze([...placements])
}

function requiredText(api: string, field: string, value: string): string {
	const normalized = String(value ?? '').trim()
	if (!normalized) throw new Error(`[workbench] ${api}(): ${field} required`)
	return normalized
}
