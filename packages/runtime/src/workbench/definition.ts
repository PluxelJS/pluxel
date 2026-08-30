import type { BasePlugin, PluginNodeAddress } from '@pluxel/core'
import type { RpcTarget } from '../capnweb'

const DEFINITION = Symbol('pluxel.workbench.definition')
const DESCRIPTOR = Symbol('pluxel.workbench.descriptor')
const RENDERER_ENTRY = Symbol('pluxel.workbench.renderer-entry')

const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/
const GROUP_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const ROUTE_PARAMETER = /^[A-Za-z][A-Za-z0-9_]*$/
const ROUTE_LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/
const RESERVED_ENTRY_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'then'])

declare const apiType: unique symbol
declare const consumerApiType: unique symbol
declare const definitionEntries: unique symbol

const WORKBENCH_ICONS = Object.freeze({
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
} as const)

export type WorkbenchIcon = (typeof WORKBENCH_ICONS)[keyof typeof WORKBENCH_ICONS]

const WORKBENCH_ICON_VALUES = new Set<string>(Object.values(WORKBENCH_ICONS))

export type WorkbenchGroup = Readonly<{
	id: string
	label: string
	icon?: WorkbenchIcon
}>

export type WorkbenchTabPlacement = Readonly<{
	kind: 'tab'
	label?: string
	icon?: WorkbenchIcon
	group?: WorkbenchGroup
	order: number
}>

export type WorkbenchNavigation = Readonly<{
	label: string
	group?: WorkbenchGroup
}>

export type WorkbenchRoutePlacement = Readonly<{
	kind: 'route'
	path: string
	title: string
	icon?: WorkbenchIcon
	navigation?: WorkbenchNavigation
	frame: 'shell' | 'standalone'
	order: number
}>

export type WorkbenchPlacement = WorkbenchTabPlacement | WorkbenchRoutePlacement

export type WorkbenchRendererEntry = Readonly<{
	readonly [RENDERER_ENTRY]: WorkbenchRendererEntryMetadata
}>

type DescriptorBrand<Api extends RpcTarget, ConsumerApi extends RpcTarget | never = never> = {
	/** @internal Invariant phantom types; no property is emitted at runtime. */
	readonly [apiType]: (value: Api) => Api
	/** @internal Invariant phantom types; no property is emitted at runtime. */
	readonly [consumerApiType]: (value: ConsumerApi) => ConsumerApi
}

export type WorkbenchView<Api extends RpcTarget> = Readonly<{
	kind: 'view'
	renderer: WorkbenchRendererEntry
	placement: WorkbenchPlacement
}> &
	DescriptorBrand<Api>

export type WorkbenchAttachment<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never = never,
> = Readonly<{
	kind: 'attachment'
	renderer: WorkbenchRendererEntry
	place(placement: WorkbenchPlacement): WorkbenchAttachmentPlacement<ProviderApi, ConsumerApi>
}> &
	DescriptorBrand<ProviderApi, ConsumerApi>

export type WorkbenchAttachmentPlacement<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never = never,
> = Readonly<{
	kind: 'attachment-placement'
	provider: WorkbenchAttachment<ProviderApi, ConsumerApi>
	placement: WorkbenchPlacement
}> &
	DescriptorBrand<ProviderApi, ConsumerApi>

export type WorkbenchEntry = Readonly<{
	kind: 'view' | 'attachment' | 'attachment-placement'
}>

/** @internal Existential descriptor shapes used across the fixed Workbench entries. */
export type WorkbenchRenderableDescriptor =
	| Readonly<{
			kind: 'view'
			renderer: WorkbenchRendererEntry
			placement: WorkbenchPlacement
	  }>
	| Readonly<{
			kind: 'attachment'
			renderer: WorkbenchRendererEntry
			place(placement: WorkbenchPlacement): WorkbenchEntry
	  }>

/** @internal Extracts the invariant API brand without comparing it to `any`. */
export type WorkbenchDescriptorApi<Descriptor> =
	Descriptor extends Readonly<{
		readonly [apiType]: (value: infer Api) => unknown
	}>
		? Api extends RpcTarget
			? Api
			: never
		: never

/** @internal Extracts the optional invariant consumer API brand, including `never`. */
export type WorkbenchDescriptorConsumerApi<Descriptor> =
	Descriptor extends Readonly<{
		readonly [consumerApiType]: (value: infer Api) => unknown
	}>
		? Api extends RpcTarget
			? Api
			: never
		: never

export type WorkbenchEntryMap = Readonly<Record<string, WorkbenchEntry>>

export type WorkbenchDefinition<Entries extends WorkbenchEntryMap> = Readonly<{
	[Key in keyof Entries]: Entries[Key]
}> & {
	/** @internal Inference marker; no property is emitted at runtime. */
	readonly [definitionEntries]?: Entries
}

export type AnyWorkbenchDefinition = WorkbenchDefinition<WorkbenchEntryMap>

export type WorkbenchPrincipal = Readonly<{
	provider: string
	subject: string
	displayName?: string
}>

export type WorkbenchViewOpenContext = Readonly<{
	principal: WorkbenchPrincipal
	params: Readonly<Record<string, string>>
	signal: AbortSignal
}>

export type WorkbenchAttachmentOpenContext = WorkbenchViewOpenContext &
	Readonly<{
		consumer: Readonly<{ node: PluginNodeAddress }>
	}>

export type WorkbenchTargetFactory<Api extends RpcTarget> = (
	context: WorkbenchViewOpenContext,
) => Api | Promise<Api>

export type WorkbenchAttachmentTargetFactory<Api extends RpcTarget> = (
	context: WorkbenchAttachmentOpenContext,
) => Api | Promise<Api>

type BindingFor<Entry extends WorkbenchEntry> =
	Entry extends Readonly<{ kind: 'view' }>
		? WorkbenchTargetFactory<WorkbenchDescriptorApi<Entry>>
		: Entry extends Readonly<{ kind: 'attachment' }>
			? WorkbenchAttachmentTargetFactory<WorkbenchDescriptorApi<Entry>>
			: Entry extends Readonly<{ kind: 'attachment-placement' }>
				? [WorkbenchDescriptorConsumerApi<Entry>] extends [never]
					? Readonly<{ provider: BasePlugin }>
					: Readonly<{
							provider: BasePlugin
							consumer: WorkbenchTargetFactory<WorkbenchDescriptorConsumerApi<Entry>>
						}>
				: never

export type WorkbenchBindings<Definition extends AnyWorkbenchDefinition> = {
	-readonly [Key in keyof Definition & string]: BindingFor<Definition[Key]>
}

export interface PluginWorkbench {
	publish<const Definition extends AnyWorkbenchDefinition>(
		definition: Definition,
		bindings: WorkbenchBindings<Definition>,
	): void
}

export type WorkbenchDescriptorMetadata =
	| Readonly<{
			kind: 'view'
			key: string
			renderer: WorkbenchRendererEntry
			placement: WorkbenchPlacement
	  }>
	| Readonly<{
			kind: 'attachment'
			key: string
			renderer: WorkbenchRendererEntry
	  }>
	| Readonly<{
			kind: 'attachment-placement'
			key: string
			provider: Extract<WorkbenchRenderableDescriptor, { kind: 'attachment' }>
			placement: WorkbenchPlacement
	  }>

export type WorkbenchDefinitionMetadata = Readonly<{
	entries: readonly WorkbenchDescriptorMetadata[]
}>

export type WorkbenchRendererEntryMetadata = Readonly<{
	moduleUrl: string
	entryPath: string
}>

function rendererEntry(moduleUrl: string | URL, entryPath: string): WorkbenchRendererEntry {
	const declarationUrl = parseModuleUrl(moduleUrl)
	const path = requiredText('entry', 'entryPath', entryPath, 2_048)
	if (!path.startsWith('./') && !path.startsWith('../')) {
		throw new TypeError('[workbench] entry(): entryPath must be module-relative')
	}
	if (path.includes('\\') || path.includes('?') || path.includes('#')) {
		throw new TypeError('[workbench] entry(): entryPath must not contain \\, ? or #')
	}
	return Object.freeze({
		[RENDERER_ENTRY]: Object.freeze({ moduleUrl: declarationUrl, entryPath: path }),
	})
}

function view<Api extends RpcTarget>(input: {
	renderer: WorkbenchRendererEntry
	placement: WorkbenchPlacement
}): WorkbenchView<Api> {
	assertExactKeys('view', input, ['renderer', 'placement'])
	assertRendererEntry(input?.renderer)
	assertPlacement(input?.placement)
	return descriptor({
		kind: 'view',
		renderer: input.renderer,
		placement: input.placement,
	}) as WorkbenchView<Api>
}

function attachment<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never = never,
>(input: { renderer: WorkbenchRendererEntry }): WorkbenchAttachment<ProviderApi, ConsumerApi> {
	assertExactKeys('attachment', input, ['renderer'])
	assertRendererEntry(input?.renderer)
	return createAttachment<ProviderApi, ConsumerApi>(input.renderer)
}

function createAttachment<ProviderApi extends RpcTarget, ConsumerApi extends RpcTarget | never>(
	renderer: WorkbenchRendererEntry,
	metadata: true | WorkbenchDescriptorMetadata = true,
): WorkbenchAttachment<ProviderApi, ConsumerApi> {
	let value: WorkbenchAttachment<ProviderApi, ConsumerApi>
	const place = (placement: WorkbenchPlacement) => {
		assertPlacement(placement)
		return descriptor({
			kind: 'attachment-placement',
			provider: value,
			placement,
		}) as WorkbenchAttachmentPlacement<ProviderApi, ConsumerApi>
	}
	value = descriptor({ kind: 'attachment', renderer, place }, metadata) as WorkbenchAttachment<
		ProviderApi,
		ConsumerApi
	>
	return value
}

function define<const Entries extends WorkbenchEntryMap>(
	input: Entries,
): WorkbenchDefinition<Entries> {
	if (!isPlainRecord(input)) {
		throw new TypeError('[workbench] define(): entries must be a plain record')
	}

	const output: Record<string, WorkbenchEntry> = Object.create(null)
	const metadata: WorkbenchDescriptorMetadata[] = []
	for (const [key, rawDescriptor] of Object.entries(input)) {
		assertEntryKey(key)
		const entry = cloneDefinitionEntry(key, rawDescriptor)
		output[key] = entry.descriptor
		metadata.push(entry.metadata)
	}

	Object.defineProperty(output, DEFINITION, {
		value: Object.freeze({
			entries: Object.freeze(metadata),
		} satisfies WorkbenchDefinitionMetadata),
		enumerable: false,
	})
	return Object.freeze(output) as WorkbenchDefinition<Entries>
}

function cloneDefinitionEntry(
	key: string,
	raw: unknown,
): Readonly<{ descriptor: WorkbenchEntry; metadata: WorkbenchDescriptorMetadata }> {
	const source = readDescriptor(raw)
	switch (source.kind) {
		case 'view': {
			const viewDescriptor = source as WorkbenchView<any>
			const metadata = Object.freeze({
				kind: 'view' as const,
				key,
				renderer: viewDescriptor.renderer,
				placement: viewDescriptor.placement,
			})
			const value = descriptor(
				{
					kind: 'view',
					renderer: viewDescriptor.renderer,
					placement: viewDescriptor.placement,
				},
				metadata,
			) as WorkbenchView<any>
			return {
				descriptor: value,
				metadata,
			}
		}
		case 'attachment': {
			const attachmentDescriptor = source as WorkbenchAttachment<any, any>
			const metadata = Object.freeze({
				kind: 'attachment' as const,
				key,
				renderer: attachmentDescriptor.renderer,
			})
			const value = createAttachment<any, any>(attachmentDescriptor.renderer, metadata)
			return {
				descriptor: value,
				metadata,
			}
		}
		case 'attachment-placement': {
			const placement = source as WorkbenchAttachmentPlacement<any, any>
			const provider = assertDefinedAttachment(placement.provider)
			const metadata = Object.freeze({
				kind: 'attachment-placement' as const,
				key,
				provider,
				placement: placement.placement,
			})
			const value = descriptor(
				{
					kind: 'attachment-placement',
					provider,
					placement: placement.placement,
				},
				metadata,
			) as WorkbenchAttachmentPlacement<any, any>
			return {
				descriptor: value,
				metadata,
			}
		}
	}
}

function tab(
	input: Readonly<{
		label?: string
		icon?: WorkbenchIcon
		group?: WorkbenchGroup
		order?: number
	}> = {},
): WorkbenchTabPlacement {
	assertExactKeys('tab', input, ['label', 'icon', 'group', 'order'])
	return Object.freeze({
		kind: 'tab',
		...(input.label === undefined ? {} : { label: requiredText('tab', 'label', input.label, 256) }),
		...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
		...(input.group === undefined ? {} : { group: normalizeGroup('tab', input.group) }),
		order: finiteOrder('tab', input.order),
	})
}

function route(
	path: string,
	input: Readonly<{
		title: string
		icon?: WorkbenchIcon
		navigation?: false | WorkbenchNavigation
		frame?: 'shell' | 'standalone'
		order?: number
	}>,
): WorkbenchRoutePlacement {
	assertExactKeys('route', input, ['title', 'icon', 'navigation', 'frame', 'order'])
	const normalizedPath = normalizeRoutePath(path)
	const parameterized = routeParameterNames(normalizedPath).length > 0
	if (parameterized && input.navigation !== undefined && input.navigation !== false) {
		throw new TypeError('[workbench] route(): parameterized routes cannot enter navigation')
	}
	const navigation =
		input.navigation !== undefined && input.navigation !== false
			? normalizeNavigation(input.navigation)
			: undefined
	return Object.freeze({
		kind: 'route',
		path: normalizedPath,
		title: requiredText('route', 'title', input.title, 256),
		...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
		...(navigation === undefined ? {} : { navigation }),
		frame: input.frame ?? 'shell',
		order: finiteOrder('route', input.order),
	})
}

function normalizeNavigation(input: WorkbenchNavigation): WorkbenchNavigation {
	assertExactKeys('route.navigation', input, ['label', 'group'])
	return Object.freeze({
		label: requiredText('route.navigation', 'label', input.label, 256),
		...(input.group === undefined
			? {}
			: { group: normalizeGroup('route.navigation', input.group) }),
	})
}

function normalizeGroup(api: string, input: WorkbenchGroup): WorkbenchGroup {
	assertExactKeys(`${api}.group`, input, ['id', 'label', 'icon'])
	return Object.freeze({
		id: requiredGroupId(api, input.id),
		label: requiredText(`${api}.group`, 'label', input.label, 256),
		...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
	})
}

function descriptor<T extends object>(
	value: T,
	metadata: true | WorkbenchDescriptorMetadata = true,
): T {
	Object.defineProperty(value, DESCRIPTOR, { value: metadata, enumerable: false })
	return Object.freeze(value)
}

function readDescriptor(value: unknown): WorkbenchEntry {
	if (!value || typeof value !== 'object' || !(value as Record<PropertyKey, unknown>)[DESCRIPTOR]) {
		throw new TypeError('[workbench] definition contains an invalid entry descriptor')
	}
	return value as WorkbenchEntry
}

function assertDefinedAttachment(
	value: unknown,
): Extract<WorkbenchRenderableDescriptor, { kind: 'attachment' }> {
	const attachmentDescriptor = readDescriptor(value)
	if (attachmentDescriptor.kind !== 'attachment') {
		throw new TypeError('[workbench] attachment placement has an invalid provider descriptor')
	}
	const metadata = (attachmentDescriptor as unknown as Record<PropertyKey, unknown>)[DESCRIPTOR]
	if (!metadata || typeof metadata !== 'object') {
		throw new TypeError(
			'[workbench] attachment must belong to a Workbench definition before it can be placed',
		)
	}
	return attachmentDescriptor as Extract<WorkbenchRenderableDescriptor, { kind: 'attachment' }>
}

function assertRendererEntry(value: unknown): asserts value is WorkbenchRendererEntry {
	if (
		!value ||
		typeof value !== 'object' ||
		!(value as Record<PropertyKey, unknown>)[RENDERER_ENTRY]
	) {
		throw new TypeError('[workbench] renderer must be created by workbench.entry()')
	}
}

function assertPlacement(value: unknown): asserts value is WorkbenchPlacement {
	if (!value || typeof value !== 'object') {
		throw new TypeError('[workbench] placement must be created by workbench.tab() or route()')
	}
	const kind = (value as { kind?: unknown }).kind
	if ((kind !== 'tab' && kind !== 'route') || !Object.isFrozen(value)) {
		throw new TypeError('[workbench] placement must be created by workbench.tab() or route()')
	}
}

function parseModuleUrl(input: string | URL): string {
	let url: URL
	try {
		url = new URL(String(input))
	} catch (cause) {
		throw new TypeError('[workbench] entry(): moduleUrl must be an absolute URL', { cause })
	}
	if (url.protocol !== 'file:' && url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError('[workbench] entry(): moduleUrl must use file:, http: or https:')
	}
	if (url.href.length > 8_192) {
		throw new TypeError('[workbench] entry(): moduleUrl exceeds the supported length')
	}
	return url.href
}

function assertEntryKey(key: string): void {
	if (key.length > 128 || !ENTRY_KEY.test(key) || RESERVED_ENTRY_KEYS.has(key)) {
		throw new TypeError(`[workbench] define(): invalid entry key "${key}"`)
	}
}

function normalizeRoutePath(path: string): string {
	const value = requiredText('route', 'path', path, 2_048)
	if (value.includes('?') || value.includes('#') || value.includes('\\')) {
		throw new TypeError('[workbench] route(): path must not contain \\, ? or #')
	}
	const normalized = `/${value.replaceAll(/^\/+|\/+$/g, '')}`
	if (normalized === '/') throw new TypeError('[workbench] route(): path must not be root')
	if (normalized.includes('//')) {
		throw new TypeError('[workbench] route(): path must not contain empty segments')
	}
	for (const segment of normalized.split('/').slice(1)) {
		if (segment.startsWith(':')) continue
		if (!ROUTE_LITERAL_SEGMENT.test(segment) || segment === '.' || segment === '..') {
			throw new TypeError(`[workbench] route(): invalid literal route segment "${segment}"`)
		}
	}
	routeParameterNames(normalized)
	return normalized
}

/** @internal Browser protocol validation only. */
export function readWorkbenchRoutePath(value: unknown): string {
	if (typeof value !== 'string') {
		throw new TypeError('[workbench] route path must be a string')
	}
	const normalized = normalizeRoutePath(value)
	if (normalized !== value) {
		throw new TypeError('[workbench] route path must be canonical')
	}
	return normalized
}

function routeParameterNames(path: string): readonly string[] {
	const names: string[] = []
	const seen = new Set<string>()
	for (const segment of path.split('/').slice(1)) {
		if (!segment.startsWith(':')) continue
		const name = segment.slice(1)
		if (!ROUTE_PARAMETER.test(name)) {
			throw new TypeError(`[workbench] route(): invalid route parameter "${segment}"`)
		}
		if (seen.has(name)) {
			throw new TypeError(`[workbench] route(): duplicate route parameter "${name}"`)
		}
		seen.add(name)
		names.push(name)
	}
	return names
}

function finiteOrder(api: string, value: number | undefined): number {
	if (value === undefined) return 0
	if (!Number.isFinite(value)) throw new TypeError(`[workbench] ${api}(): order must be finite`)
	return value
}

function requiredGroupId(api: string, value: unknown): string {
	const id = requiredText(`${api}.group`, 'id', value, 64)
	if (!GROUP_ID.test(id)) {
		throw new TypeError(`[workbench] ${api}.group: id has an invalid format`)
	}
	return id
}

export function readWorkbenchIcon(value: unknown): WorkbenchIcon {
	if (typeof value !== 'string' || !WORKBENCH_ICON_VALUES.has(value)) {
		throw new TypeError('[workbench] icon is not part of the fixed Workbench icon set')
	}
	return value as WorkbenchIcon
}

function requiredText(api: string, field: string, value: unknown, max: number): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > max ||
		value.trim() !== value
	) {
		throw new TypeError(
			`[workbench] ${api}(): ${field} must be non-empty without surrounding whitespace`,
		)
	}
	return value
}

function assertExactKeys(api: string, value: unknown, allowed: readonly string[]): void {
	if (!isPlainRecord(value))
		throw new TypeError(`[workbench] ${api}(): options must be a plain record`)
	const extras = Object.keys(value).filter((key) => !allowed.includes(key))
	if (extras.length > 0) {
		throw new TypeError(`[workbench] ${api}(): unsupported option "${extras[0]}"`)
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

/** @internal Toolchain/server lowering only. */
export function readWorkbenchDefinition(
	definition: AnyWorkbenchDefinition,
): WorkbenchDefinitionMetadata {
	const metadata = (definition as unknown as Record<PropertyKey, unknown>)[DEFINITION]
	if (!metadata || typeof metadata !== 'object') {
		throw new TypeError('[workbench] invalid Workbench definition')
	}
	return metadata as WorkbenchDefinitionMetadata
}

/** @internal Toolchain/server lowering only. */
export function readWorkbenchDescriptor(entry: WorkbenchEntry): WorkbenchDescriptorMetadata {
	readDescriptor(entry)
	const metadata = (entry as unknown as Record<PropertyKey, unknown>)[DESCRIPTOR]
	if (metadata && typeof metadata === 'object') return metadata as WorkbenchDescriptorMetadata
	throw new TypeError('[workbench] descriptor is not owned by a Workbench definition')
}

/** @internal Toolchain lowering only. */
export function readWorkbenchRendererEntry(
	entry: WorkbenchRendererEntry,
): WorkbenchRendererEntryMetadata {
	assertRendererEntry(entry)
	return entry[RENDERER_ENTRY]
}

export const workbench = Object.freeze({
	define,
	view,
	attachment,
	entry: rendererEntry,
	tab,
	route,
	icons: WORKBENCH_ICONS,
})
