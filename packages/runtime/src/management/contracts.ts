import type { BuiltinDocContent } from './document-contracts'

export const ManagementPlacements = {
	GlobalHeaderActions: 'global.header-actions',
	GlobalNavbarItems: 'global.navbar-items',
	GlobalNavbarFooter: 'global.navbar-footer',
	GlobalStatusBar: 'global.status-bar',
	PluginHeader: 'plugin.header',
	PluginTabs: 'plugin.tabs',
	PluginActions: 'plugin.actions',
	PluginContext: 'plugin.context',
	PluginInfo: 'plugin.info',
	PluginDock: 'plugin.dock',
	PluginCapabilities: 'plugin.capabilities',
	PluginRoutes: 'plugin.routes',
} as const

export type ManagementPlacement = (typeof ManagementPlacements)[keyof typeof ManagementPlacements]

export type ManagementAudience =
	| { readonly kind: 'self' }
	| {
			readonly kind: 'dependents'
			readonly relations: readonly ManagementRelationKind[]
	  }

export type ManagementRelationKind = 'required'

export const managementAudience = {
	self(): ManagementAudience {
		return Object.freeze({ kind: 'self' })
	},
	requiredDependents(): ManagementAudience {
		return Object.freeze({ kind: 'dependents', relations: Object.freeze(['required'] as const) })
	},
} as const

export type ManagementViewRef =
	| {
			readonly kind: 'remote'
			readonly export: string
	  }
	| {
			readonly kind: 'builtin'
			readonly renderer: 'document' | 'form' | 'table' | 'action'
			readonly props: Readonly<Record<string, unknown>>
	  }

export function remoteView(exportName: string): ManagementViewRef {
	const normalized = String(exportName ?? '').trim()
	if (!normalized) throw new Error('[management] remoteView(): export name required')
	return Object.freeze({ kind: 'remote', export: normalized })
}

export function builtinView(
	renderer: Extract<ManagementViewRef, { kind: 'builtin' }>['renderer'],
	props: Readonly<Record<string, unknown>>,
): ManagementViewRef {
	return Object.freeze({ kind: 'builtin', renderer, props: Object.freeze({ ...props }) })
}

export type ManagementDocumentProps = Readonly<{
	title?: string
	description?: string
	content: BuiltinDocContent
}>

export function managementDocument(props: ManagementDocumentProps): ManagementViewRef {
	return builtinView('document', props as Readonly<Record<string, unknown>>)
}

export type ManagementContributionMeta = Readonly<{
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

export type ManagementViewContribution = Readonly<{
	kind: 'view'
	id: string
	placement: ManagementPlacement
	audience: ManagementAudience
	view: ManagementViewRef
	priority?: number
	requireRunning?: boolean
	meta?: ManagementContributionMeta
}>

export type ManagementPortContract<
	Resources extends ManagementResourceMap = ManagementResourceMap,
> = Readonly<{
	id: string
	version: number
	resources: Resources
}>

export type ManagementPortContribution = Readonly<{
	kind: 'port'
	id: string
	placement: ManagementPlacement
	port: ManagementPortContract<any>
	providers?: readonly string[]
	priority?: number
	requireRunning?: boolean
	meta?: ManagementContributionMeta
	bindings?: Readonly<Record<string, string>>
}>

export type ManagementPortRendererContribution = Readonly<{
	kind: 'port-renderer'
	id: string
	port: ManagementPortContract<any>
	view: ManagementViewRef
	priority?: number
	requireRunning?: boolean
}>

export type ManagementContribution =
	| ManagementViewContribution
	| ManagementPortContribution
	| ManagementPortRendererContribution

export type ManagementResourceRef = Readonly<{
	binding: string
	kind: 'api' | 'collection' | 'stream'
}>

export type ManagementLayoutItem = Readonly<{
	id: string
	owner: string
	target: string
	placement: ManagementPlacement
	view: ManagementViewRef
	priority: number
	requireRunning: boolean
	meta?: ManagementContributionMeta
	resources: Readonly<Record<string, ManagementResourceRef>>
}>

export type ManagementLayout = Readonly<{
	revision: number
	target: string | null
	items: readonly ManagementLayoutItem[]
}>

export type ManagementUiArtifact = Readonly<{
	pluginName: string
	remoteName: string
	manifestUrl: string
	exposedModule: string
	sourceHash: string
	compiledAt: number
}>

export type ManagementUiArtifactState = Readonly<{
	pluginName: string
	state: 'building' | 'ready' | 'error'
	updatedAt: number
	sourceHash?: string
	compiledAt?: number
	message?: string
}>

export type ManagementArtifactEvent =
	| Readonly<{ type: 'sync'; revision: number }>
	| Readonly<{
			type: 'building'
			revision: number
			pluginName: string
			updatedAt: number
			sourceHash?: string
			compiledAt?: number
	  }>
	| Readonly<{
			type: 'error'
			revision: number
			pluginName: string
			updatedAt: number
			sourceHash?: string
			compiledAt?: number
			message: string
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

export type ManagementCatalog = Readonly<{
	revision: number
	modules: readonly ManagementUiArtifact[]
	states: readonly ManagementUiArtifactState[]
}>

export function managementView(
	input: Omit<ManagementViewContribution, 'kind' | 'audience'> & {
		audience?: ManagementAudience
	},
): ManagementViewContribution {
	return Object.freeze({
		...input,
		kind: 'view',
		id: requiredId('managementView', input.id),
		audience: input.audience ?? managementAudience.self(),
	})
}

export function managementPort(
	input: Omit<ManagementPortContribution, 'kind'>,
): ManagementPortContribution {
	return Object.freeze({
		...input,
		kind: 'port',
		id: requiredId('managementPort', input.id),
	})
}

export function managementPortRenderer(
	input: Omit<ManagementPortRendererContribution, 'kind'>,
): ManagementPortRendererContribution {
	return Object.freeze({
		...input,
		kind: 'port-renderer',
		id: requiredId('managementPortRenderer', input.id),
	})
}

export function defineManagementPort<const Resources extends ManagementResourceMap>(
	id: string,
	resources: Resources,
	version = 1,
): ManagementPortContract<Resources> {
	const normalized = requiredId('defineManagementPort', id)
	if (!Number.isInteger(version) || version <= 0) {
		throw new Error('[management] defineManagementPort(): version must be a positive integer')
	}
	return Object.freeze({ id: normalized, version, resources: Object.freeze({ ...resources }) })
}

declare const managementResourceType: unique symbol

export type ManagementApiResource<TApi> = Readonly<{
	kind: 'api'
	readonly [managementResourceType]?: TApi
}>

export type ManagementCollectionItem = Readonly<{ id: string }>

export type ManagementCollectionResource<TItem extends ManagementCollectionItem> = Readonly<{
	kind: 'collection'
	readonly [managementResourceType]?: TItem
}>

export type ManagementStreamResource<TEvent> = Readonly<{
	kind: 'stream'
	readonly [managementResourceType]?: TEvent
}>

export type ManagementResourceContract =
	| ManagementApiResource<unknown>
	| ManagementCollectionResource<ManagementCollectionItem>
	| ManagementStreamResource<unknown>

export const managementResource = {
	api<TApi>(): ManagementApiResource<TApi> {
		return Object.freeze({ kind: 'api' }) as ManagementApiResource<TApi>
	},
	collection<TItem extends ManagementCollectionItem>(): ManagementCollectionResource<TItem> {
		return Object.freeze({ kind: 'collection' }) as ManagementCollectionResource<TItem>
	},
	stream<TEvent>(): ManagementStreamResource<TEvent> {
		return Object.freeze({ kind: 'stream' }) as ManagementStreamResource<TEvent>
	},
} as const

export type ManagementResourceMap = Readonly<Record<string, ManagementResourceContract>>

export type ManagementUiSourceDeclaration = Readonly<{
	entryPath: string
}>

export type ManagementModule<Resources extends ManagementResourceMap = ManagementResourceMap> =
	Readonly<{
		id: string
		ui?: ManagementUiSourceDeclaration
		resources: Resources
		contributions: readonly ManagementContribution[]
	}>

export type AnyManagementModule = ManagementModule<any>

export function defineManagementModule<const Resources extends ManagementResourceMap>(input: {
	id: string
	ui?: ManagementUiSourceDeclaration
	resources?: Resources
	contributions?: readonly ManagementContribution[]
}): ManagementModule<Resources> {
	const id = requiredId('defineManagementModule', input.id)
	const contributions = Object.freeze([...(input.contributions ?? [])])
	const seen = new Set<string>()
	for (const contribution of contributions) {
		const key = `${contribution.kind}:${contribution.id}`
		if (seen.has(key)) {
			throw new Error(`[management] duplicate contribution: ${key}`)
		}
		seen.add(key)
	}
	return Object.freeze({
		id,
		ui: input.ui,
		resources: Object.freeze({ ...input.resources }) as Resources,
		contributions,
	})
}

export type ManagementApiOf<Resource> =
	Resource extends ManagementApiResource<infer TApi> ? TApi : never

/** Browser-side RPC view: only callable API methods cross the boundary and every result is async. */
export type ManagementApiClient<TApi> = Readonly<{
	[Key in keyof TApi as TApi[Key] extends (...args: any[]) => any
		? Key
		: never]: TApi[Key] extends (...args: infer Args) => infer Result
		? (...args: Args) => Promise<Awaited<Result>>
		: never
}>

export type ManagementCollectionOf<Resource> =
	Resource extends ManagementCollectionResource<infer TItem> ? TItem : never

export type ManagementStreamOf<Resource> =
	Resource extends ManagementStreamResource<infer TEvent> ? TEvent : never

function requiredId(api: string, value: string): string {
	const normalized = String(value ?? '').trim()
	if (!normalized) throw new Error(`[management] ${api}(): id required`)
	return normalized
}
