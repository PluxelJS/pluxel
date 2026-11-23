import type { BasePlugin, PluginNodeAddress } from '@pluxel/core'
import type { GenericSchema, GenericSchemaAsync, InferOutput } from 'valibot'
import type { RpcTarget } from 'capnweb'

const definitions = new WeakMap<object, WorkbenchDefinitionMetadata>()
const descriptors = new WeakMap<object, 'unbound' | WorkbenchDescriptorMetadata>()
const DATA_SLOT = Symbol('pluxel.workbench.content-data')
const ACTION_SLOT = Symbol('pluxel.workbench.content-action')
const canonicalContentSlots = new WeakSet<object>()

const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/
const GROUP_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const ROUTE_PARAMETER = /^[A-Za-z][A-Za-z0-9_]*$/
const ROUTE_LITERAL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/
const RESERVED_ENTRY_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'then'])

declare const apiType: unique symbol
declare const consumerApiType: unique symbol
declare const declarationType: unique symbol
declare const definitionType: unique symbol
declare const definedEntryType: unique symbol

interface Declaration {
	readonly [declarationType]: true
}

export type WorkbenchDefinedEntry<Entry = unknown> = Entry & Readonly<{ [definedEntryType]: true }>

const WORKBENCH_ICONS = [
	'api',
	'brand-discord',
	'brand-telegram',
	'building',
	'chart-bar',
	'cloud-upload',
	'history',
	'message-chatbot',
	'plug-connected',
	'receipt',
	'search',
	'settings',
	'shield-lock',
	'test-pipe',
	'text-recognition',
	'typography',
	'users',
] as const

export type WorkbenchIcon = (typeof WORKBENCH_ICONS)[number]

const WORKBENCH_ICON_VALUES = new Set<string>(WORKBENCH_ICONS)

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

export type WorkbenchPanelPlacement = Readonly<{
	kind: 'panel'
	region: 'left' | 'right' | 'bottom'
	label: string
	icon?: WorkbenchIcon
	order: number
}>

export type WorkbenchPlacement =
	| WorkbenchTabPlacement
	| WorkbenchRoutePlacement
	| WorkbenchPanelPlacement

/** Placement declarations default to order 0 and route frame 'shell'. */
export type WorkbenchPlacementInput =
	| (Omit<WorkbenchTabPlacement, 'order'> & { readonly order?: number })
	| (Omit<WorkbenchRoutePlacement, 'order' | 'frame'> & {
			readonly order?: number
			readonly frame?: WorkbenchRoutePlacement['frame']
	  })
	| (Omit<WorkbenchPanelPlacement, 'order'> & { readonly order?: number })

export type WorkbenchContentSchema = GenericSchema | GenericSchemaAsync

export interface WorkbenchContentData<Schema extends WorkbenchContentSchema> {
	readonly [DATA_SLOT]: Readonly<{ schema: Schema }>
}

export interface WorkbenchContentAction<
	InputSchema extends WorkbenchContentSchema | undefined = undefined,
> {
	readonly [ACTION_SLOT]: Readonly<{
		label: string
		input: InputSchema
		form: InputSchema extends undefined ? 'none' : 'dialog' | 'embedded'
		confirm?: string
	}>
}

export type WorkbenchContentSlot =
	| WorkbenchContentData<WorkbenchContentSchema>
	| WorkbenchContentAction<undefined>
	| WorkbenchContentAction<WorkbenchContentSchema>

export type WorkbenchContentSlotMap = Readonly<Record<string, WorkbenchContentSlot>>

type DescriptorBrand<
	Api extends RpcTarget,
	ConsumerApi extends RpcTarget | never = never,
> = Declaration & {
	/** @internal Invariant phantom types; no property is emitted at runtime. */
	readonly [apiType]: (value: Api) => Api
	/** @internal Invariant phantom types; no property is emitted at runtime. */
	readonly [consumerApiType]: (value: ConsumerApi) => ConsumerApi
}

export type WorkbenchView<Api extends RpcTarget> = Readonly<{
	kind: 'view'
	renderer: string
	placement: WorkbenchPlacement
}> &
	DescriptorBrand<Api>

export interface WorkbenchContent<Slots extends WorkbenchContentSlotMap = {}> extends Declaration {
	readonly kind: 'content'
	readonly document: string
	readonly slots: Slots
	readonly placement: WorkbenchPlacement
}

export type WorkbenchAttachment<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never = never,
> = Readonly<{
	kind: 'attachment'
	renderer: string
	place(placement: WorkbenchPlacementInput): WorkbenchAttachmentPlacement<ProviderApi, ConsumerApi>
}> &
	DescriptorBrand<ProviderApi, ConsumerApi>

export type WorkbenchAttachmentPlacement<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never = never,
> = Readonly<{
	kind: 'attachment-placement'
	provider: WorkbenchAttachment<ProviderApi, ConsumerApi> & WorkbenchDefinedEntry
	placement: WorkbenchPlacement
}> &
	DescriptorBrand<ProviderApi, ConsumerApi>

export type WorkbenchEntry = Readonly<{
	kind: 'view' | 'attachment' | 'attachment-placement' | 'content'
}>

/** @internal Existential descriptor shapes used across the fixed Workbench entries. */
export type WorkbenchRenderableDescriptor = WorkbenchDefinedEntry &
	(
		| Readonly<{
				kind: 'view'
				renderer: string
				placement: WorkbenchPlacement
		  }>
		| Readonly<{
				kind: 'attachment'
				renderer: string
				place(placement: WorkbenchPlacementInput): WorkbenchEntry
		  }>
	)

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
	[Key in keyof Entries]: WorkbenchDefinedEntry<
		Entries[Key] extends { readonly kind: 'attachment' }
			? WorkbenchAttachment<
					WorkbenchDescriptorApi<Entries[Key]>,
					WorkbenchDescriptorConsumerApi<Entries[Key]>
				>
			: Entries[Key]
	>
}> & {
	readonly [definitionType]: true
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

type WorkbenchContentSlotsOf<Entry> = Entry extends WorkbenchContent<infer Slots> ? Slots : never

type WorkbenchContentDataKey<Slots extends WorkbenchContentSlotMap> = {
	[Key in keyof Slots & string]: Slots[Key] extends WorkbenchContentData<any> ? Key : never
}[keyof Slots & string]

type WorkbenchContentActionKey<Slots extends WorkbenchContentSlotMap> = {
	[Key in keyof Slots & string]: Slots[Key] extends WorkbenchContentAction<any> ? Key : never
}[keyof Slots & string]

type WorkbenchContentDataValue<Value> = Value extends readonly unknown[]
	? { readonly [Key in keyof Value]: WorkbenchContentDataValue<Value[Key]> }
	: Value extends object
		? { readonly [Key in keyof Value]: WorkbenchContentDataValue<Value[Key]> }
		: Value

type WorkbenchContentDataValues<Slots extends WorkbenchContentSlotMap> = Readonly<{
	[Key in WorkbenchContentDataKey<Slots>]: Slots[Key] extends WorkbenchContentData<infer Schema>
		? WorkbenchContentDataValue<InferOutput<Schema>>
		: never
}>

export type WorkbenchContentActionResult =
	| void
	| Readonly<{ ok: true; message: string }>
	| Readonly<{ ok: false; message: string }>

type WorkbenchContentActionHandler<Slot extends WorkbenchContentSlot> =
	Slot extends WorkbenchContentAction<infer Schema>
		? Schema extends WorkbenchContentSchema
			? (
					input: InferOutput<Schema>,
				) => WorkbenchContentActionResult | Promise<WorkbenchContentActionResult>
			: () => WorkbenchContentActionResult | Promise<WorkbenchContentActionResult>
		: never

type WorkbenchContentActionHandlers<Slots extends WorkbenchContentSlotMap> = Readonly<{
	[Key in WorkbenchContentActionKey<Slots>]: WorkbenchContentActionHandler<Slots[Key]>
}>

export type WorkbenchContentBinding<Slots extends WorkbenchContentSlotMap> = ([
	WorkbenchContentDataKey<Slots>,
] extends [never]
	? Readonly<{ load?: never; subscribe?: never }>
	: Readonly<{
			load(): WorkbenchContentDataValues<Slots> | Promise<WorkbenchContentDataValues<Slots>>
			/** Subscribe before the first load; this open owns and releases the returned subscription. */
			subscribe?(changed: () => void): Disposable
		}>) &
	([WorkbenchContentActionKey<Slots>] extends [never]
		? Readonly<{ actions?: never }>
		: Readonly<{ actions: WorkbenchContentActionHandlers<Slots> }>)

export type WorkbenchContentFactory<Slots extends WorkbenchContentSlotMap> = (
	context: WorkbenchViewOpenContext,
) => WorkbenchContentBinding<Slots> | Promise<WorkbenchContentBinding<Slots>>

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
				: Entry extends WorkbenchContent<infer Slots>
					? WorkbenchContentFactory<Slots>
					: never

type WorkbenchBindingKey<Definition extends AnyWorkbenchDefinition> = {
	[Key in keyof Definition & string]: Definition[Key] extends Readonly<{ kind: 'content' }>
		? keyof WorkbenchContentSlotsOf<Definition[Key]> extends never
			? never
			: Key
		: Key
}[keyof Definition & string]

export type WorkbenchBindings<Definition extends AnyWorkbenchDefinition> = {
	-readonly [Key in WorkbenchBindingKey<Definition>]: BindingFor<Definition[Key]>
}

/** @internal Shared by the public Context view and its Runtime implementation. */
export type WorkbenchPublishBindings<Definition extends AnyWorkbenchDefinition> =
	WorkbenchBindingKey<Definition> extends never
		? readonly []
		: readonly [bindings: WorkbenchBindings<Definition>]

export interface PluginWorkbench {
	publish<const Definition extends AnyWorkbenchDefinition>(
		definition: Definition,
		...bindings: WorkbenchPublishBindings<Definition>
	): void
}

type WorkbenchEntryDeclaration =
	| Readonly<{
			kind: 'view'
			renderer: string
			placement: WorkbenchPlacement
	  }>
	| Readonly<{
			kind: 'attachment'
			renderer: string
	  }>
	| Readonly<{
			kind: 'attachment-placement'
			provider: Extract<WorkbenchRenderableDescriptor, { kind: 'attachment' }>
			placement: WorkbenchPlacement
	  }>
	| Readonly<{
			kind: 'content'
			document: string
			slots: WorkbenchContentSlotMap
			placement: WorkbenchPlacement
	  }>

export type WorkbenchDescriptorMetadata = WorkbenchEntryDeclaration &
	Readonly<{ key: string; moduleUrl: string }>

export type WorkbenchDefinitionMetadata = Readonly<{
	entries: readonly WorkbenchDescriptorMetadata[]
}>

export type WorkbenchContentDataMetadata = Readonly<{
	kind: 'data'
	schema: WorkbenchContentSchema
}>

export type WorkbenchContentActionMetadata = Readonly<{
	kind: 'action'
	label: string
	input?: WorkbenchContentSchema
	form: 'none' | 'dialog' | 'embedded'
	confirm?: string
}>

export type WorkbenchContentSlotMetadata =
	| WorkbenchContentDataMetadata
	| WorkbenchContentActionMetadata

function data<Schema extends WorkbenchContentSchema>(schema: Schema): WorkbenchContentData<Schema> {
	assertValibotSchema('data', schema)
	const slot = Object.freeze({ [DATA_SLOT]: Object.freeze({ schema }) })
	canonicalContentSlots.add(slot)
	return slot
}

function action(input: {
	label: string
	input?: never
	form?: never
	confirm?: string
}): WorkbenchContentAction<undefined>
function action<const InputSchema extends WorkbenchContentSchema>(input: {
	label: string
	input: InputSchema
	form?: 'embedded'
	confirm?: string
}): WorkbenchContentAction<InputSchema>
function action(input?: {
	label?: unknown
	input?: unknown
	form?: unknown
	confirm?: unknown
}): WorkbenchContentAction<WorkbenchContentSchema> | WorkbenchContentAction<undefined> {
	if (input === undefined) {
		throw new TypeError('[workbench] action(): options are required')
	}
	assertExactKeys('action', input, ['label', 'input', 'form', 'confirm'])
	const label = requiredUtf8Text('action', 'label', input.label, 128)
	const confirm =
		input.confirm === undefined
			? undefined
			: requiredUtf8Text('action', 'confirm', input.confirm, 1_024)
	if (input.input === undefined) {
		if (input.form !== undefined) {
			throw new TypeError('[workbench] action(): form requires an input schema')
		}
		const slot = Object.freeze({
			[ACTION_SLOT]: Object.freeze({
				label,
				input: undefined,
				form: 'none' as const,
				...(confirm === undefined ? {} : { confirm }),
			}),
		})
		canonicalContentSlots.add(slot)
		return slot
	}
	assertValibotSchema('action', input.input)
	if (input.form !== undefined && input.form !== 'embedded') {
		throw new TypeError('[workbench] action(): form must be "embedded"')
	}
	const form = input.form === 'embedded' ? 'embedded' : 'dialog'
	const slot = Object.freeze({
		[ACTION_SLOT]: Object.freeze({
			label,
			input: input.input,
			form,
			...(confirm === undefined ? {} : { confirm }),
		}),
	})
	canonicalContentSlots.add(slot)
	return slot
}

function view<Api extends RpcTarget>(input: {
	renderer: string
	placement: WorkbenchPlacementInput
}): WorkbenchView<Api> {
	assertExactKeys('view', input, ['renderer', 'placement'])
	return descriptor({
		kind: 'view',
		renderer: parseWorkbenchSourcePath('renderer', input.renderer),
		placement: parseWorkbenchPlacement(input.placement),
	}) as WorkbenchView<Api>
}

function content(input: {
	document: string
	placement: WorkbenchPlacementInput
	slots?: never
}): WorkbenchContent<{}>
function content<const Slots extends WorkbenchContentSlotMap>(input: {
	document: string
	slots: Slots
	placement: WorkbenchPlacementInput
}): WorkbenchContent<Slots>
function content(input: {
	document: string
	slots?: WorkbenchContentSlotMap
	placement: WorkbenchPlacementInput
}): WorkbenchContent<WorkbenchContentSlotMap> {
	assertExactKeys('content', input, ['document', 'slots', 'placement'])
	return descriptor({
		kind: 'content',
		document: parseWorkbenchSourcePath('document', input.document),
		slots: normalizeContentSlots(Object.hasOwn(input, 'slots') ? input.slots : {}),
		placement: parseWorkbenchPlacement(input.placement),
	}) as WorkbenchContent<WorkbenchContentSlotMap>
}

function attachment<
	ProviderApi extends RpcTarget,
	ConsumerApi extends RpcTarget | never = never,
>(input: { renderer: string }): Omit<WorkbenchAttachment<ProviderApi, ConsumerApi>, 'place'> {
	assertExactKeys('attachment', input, ['renderer'])
	return descriptor({
		kind: 'attachment',
		renderer: parseWorkbenchSourcePath('renderer', input.renderer),
	}) as Omit<WorkbenchAttachment<ProviderApi, ConsumerApi>, 'place'>
}

function defineAttachment(metadata: Extract<WorkbenchDescriptorMetadata, { kind: 'attachment' }>) {
	const provider = descriptor(
		{
			kind: 'attachment' as const,
			renderer: metadata.renderer,
			place(placement: WorkbenchPlacementInput): WorkbenchEntry {
				return descriptor({
					kind: 'attachment-placement',
					provider,
					placement: parseWorkbenchPlacement(placement),
				})
			},
		},
		metadata,
	)
	return provider
}

function define<
	const Entries extends Readonly<
		Record<
			string,
			WorkbenchEntryDeclaration & Declaration & { readonly [definedEntryType]?: never }
		>
	>,
>(moduleUrl: string | URL, input: Entries): WorkbenchDefinition<Entries> {
	const owner = parseModuleUrl(moduleUrl)
	if (!isPlainRecord(input)) {
		throw new TypeError('[workbench] define(): entries must be a plain record')
	}
	if (Object.keys(input).length === 0) {
		throw new TypeError('[workbench] define(): entries must not be empty')
	}

	const output: Record<string, WorkbenchEntry> = Object.create(null)
	const entries: WorkbenchDescriptorMetadata[] = []
	for (const [key, raw] of Object.entries(input)) {
		assertEntryKey(key)
		const existing = descriptors.get(raw)
		if (!existing) {
			throw new TypeError('[workbench] definition contains an invalid entry descriptor')
		}
		if (existing !== 'unbound') {
			throw new TypeError(
				`[workbench] define(): entry "${key}" already belongs to a Workbench definition`,
			)
		}
		const metadata = Object.freeze({ ...raw, key, moduleUrl: owner })
		entries.push(metadata)
		output[key] =
			metadata.kind === 'attachment' ? defineAttachment(metadata) : descriptor({ ...raw }, metadata)
	}

	definitions.set(output, Object.freeze({ entries: Object.freeze(entries) }))
	return Object.freeze(output) as WorkbenchDefinition<Entries>
}

/** @internal Shared by runtime declarations and static compilation. */
export function parseWorkbenchPlacement(input: unknown): WorkbenchPlacement {
	if (!isPlainRecord(input)) {
		throw new TypeError('[workbench] placement must be a plain record')
	}
	switch (input.kind) {
		case 'tab': {
			assertExactKeys('tab', input, ['kind', 'label', 'icon', 'group', 'order'])
			return Object.freeze({
				kind: 'tab',
				...(input.label === undefined
					? {}
					: { label: requiredText('tab', 'label', input.label, 256) }),
				...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
				...(input.group === undefined ? {} : { group: normalizeGroup('tab', input.group) }),
				order: finiteOrder('tab', input.order),
			})
		}
		case 'panel': {
			assertExactKeys('panel', input, ['kind', 'region', 'label', 'icon', 'order'])
			const region = input.region
			if (region !== 'left' && region !== 'right' && region !== 'bottom') {
				throw new TypeError('[workbench] panel region must be left, right, or bottom')
			}
			return Object.freeze({
				kind: 'panel',
				region,
				label: requiredText('panel', 'label', input.label, 256),
				...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
				order: finiteOrder('panel', input.order),
			})
		}
		case 'route': {
			assertExactKeys('route', input, [
				'kind',
				'path',
				'title',
				'icon',
				'navigation',
				'frame',
				'order',
			])
			const path = readWorkbenchRoutePath(input.path)
			if (path.includes('/:') && input.navigation !== undefined) {
				throw new TypeError('[workbench] parameterized routes cannot enter navigation')
			}
			const frame = input.frame === undefined ? 'shell' : input.frame
			if (frame !== 'shell' && frame !== 'standalone') {
				throw new TypeError('[workbench] route frame must be shell or standalone')
			}
			return Object.freeze({
				kind: 'route',
				path,
				title: requiredText('route', 'title', input.title, 256),
				...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
				...(input.navigation === undefined
					? {}
					: { navigation: normalizeNavigation(input.navigation) }),
				frame,
				order: finiteOrder('route', input.order),
			})
		}
		default:
			throw new TypeError('[workbench] placement kind must be tab, route, or panel')
	}
}

function normalizeNavigation(input: unknown): WorkbenchNavigation {
	assertExactKeys('route.navigation', input, ['label', 'group'])
	return Object.freeze({
		label: requiredText('route.navigation', 'label', input.label, 256),
		...(input.group === undefined
			? {}
			: { group: normalizeGroup('route.navigation', input.group) }),
	})
}

function normalizeGroup(api: string, input: unknown): WorkbenchGroup {
	assertExactKeys(`${api}.group`, input, ['id', 'label', 'icon'])
	return Object.freeze({
		id: requiredGroupId(api, input.id),
		label: requiredText(`${api}.group`, 'label', input.label, 256),
		...(input.icon === undefined ? {} : { icon: readWorkbenchIcon(input.icon) }),
	})
}

function descriptor<T extends object>(value: T, metadata?: WorkbenchDescriptorMetadata): T {
	descriptors.set(value, metadata ?? 'unbound')
	return Object.freeze(value)
}

function normalizeContentSlots(input: unknown): WorkbenchContentSlotMap {
	if (!isPlainRecord(input)) {
		throw new TypeError('[workbench] content(): slots must be a plain record')
	}
	const output: Record<string, WorkbenchContentSlot> = Object.create(null)
	for (const [key, slot] of Object.entries(input)) {
		assertEntryKey(key)
		readContentSlotMetadata(slot)
		output[key] = slot as WorkbenchContentSlot
	}
	return Object.freeze(output)
}

function readContentSlotMetadata(value: unknown): WorkbenchContentSlotMetadata {
	if (!value || typeof value !== 'object' || !canonicalContentSlots.has(value)) {
		throw new TypeError(
			'[workbench] content(): every slot must be created by workbench.data() or action()',
		)
	}
	const record = value as Record<PropertyKey, unknown>
	const dataMetadata = record[DATA_SLOT]
	if (dataMetadata && typeof dataMetadata === 'object') {
		return Object.freeze({
			kind: 'data',
			schema: (dataMetadata as { schema: WorkbenchContentSchema }).schema,
		})
	}
	const actionMetadata = record[ACTION_SLOT]
	if (actionMetadata && typeof actionMetadata === 'object') {
		const metadata = actionMetadata as {
			label: string
			input?: WorkbenchContentSchema
			form: 'none' | 'dialog' | 'embedded'
			confirm?: string
		}
		return Object.freeze({
			kind: 'action',
			label: metadata.label,
			...(metadata.input === undefined ? {} : { input: metadata.input }),
			form: metadata.form,
			...(metadata.confirm === undefined ? {} : { confirm: metadata.confirm }),
		})
	}
	throw new TypeError(
		'[workbench] content(): every slot must be created by workbench.data() or action()',
	)
}

function assertValibotSchema(
	api: 'data' | 'action',
	value: unknown,
): asserts value is WorkbenchContentSchema {
	if (
		!value ||
		typeof value !== 'object' ||
		(value as { kind?: unknown }).kind !== 'schema' ||
		(value as { ['~standard']?: { version?: unknown; vendor?: unknown } })['~standard']?.version !==
			1 ||
		(value as { ['~standard']?: { version?: unknown; vendor?: unknown } })['~standard']?.vendor !==
			'valibot'
	) {
		throw new TypeError(`[workbench] ${api}(): schema must be a Valibot schema`)
	}
}

function parseModuleUrl(input: string | URL): string {
	let url: URL
	try {
		url = new URL(input)
	} catch (cause) {
		throw new TypeError('[workbench] define(): moduleUrl must be an absolute URL', { cause })
	}
	if (url.protocol !== 'file:' && url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError('[workbench] define(): moduleUrl must use file:, http: or https:')
	}
	if (url.href.length > 8_192) {
		throw new TypeError('[workbench] define(): moduleUrl exceeds the supported length')
	}
	return url.href
}

/** @internal Shared by runtime declarations and static compilation. */
export function parseWorkbenchSourcePath(field: 'renderer' | 'document', input: unknown): string {
	const path = requiredText('define', field, input, 2_048)
	if (!path.startsWith('./') && !path.startsWith('../')) {
		throw new TypeError(`[workbench] ${field} must be module-relative`)
	}
	if (path.includes('\\') || path.includes('?') || path.includes('#')) {
		throw new TypeError(`[workbench] ${field} must not contain \\, ? or #`)
	}
	if (field === 'document' && !path.toLowerCase().endsWith('.md')) {
		throw new TypeError('[workbench] document must use the .md extension')
	}
	return path
}

function assertEntryKey(key: string): void {
	if (key.length > 128 || !ENTRY_KEY.test(key) || RESERVED_ENTRY_KEYS.has(key)) {
		throw new TypeError(`[workbench] define(): invalid entry key "${key}"`)
	}
}

function readWorkbenchRoutePath(input: unknown): string {
	const path = requiredText('route', 'path', input, 2_048)
	if (path.includes('?') || path.includes('#') || path.includes('\\')) {
		throw new TypeError('[workbench] route path must not contain \\, ? or #')
	}
	if (path === '/') throw new TypeError('[workbench] route path must not be root')
	if (!path.startsWith('/') || path.endsWith('/')) {
		throw new TypeError('[workbench] route path must be canonical')
	}
	if (path.includes('//')) {
		throw new TypeError('[workbench] route path must not contain empty segments')
	}
	const parameters = new Set<string>()
	for (const segment of path.slice(1).split('/')) {
		if (segment.startsWith(':')) {
			const name = segment.slice(1)
			if (!ROUTE_PARAMETER.test(name)) {
				throw new TypeError(`[workbench] invalid route parameter "${segment}"`)
			}
			if (parameters.has(name)) {
				throw new TypeError(`[workbench] duplicate route parameter "${name}"`)
			}
			parameters.add(name)
		} else if (!ROUTE_LITERAL_SEGMENT.test(segment) || segment === '.' || segment === '..') {
			throw new TypeError(`[workbench] invalid literal route segment "${segment}"`)
		}
	}
	return path
}

function finiteOrder(api: string, value: unknown): number {
	if (value === undefined) return 0
	if (typeof value !== 'number' || !Number.isFinite(value))
		throw new TypeError(`[workbench] ${api}(): order must be finite`)
	return value
}

function requiredGroupId(api: string, value: unknown): string {
	const id = requiredText(`${api}.group`, 'id', value, 64)
	if (!GROUP_ID.test(id)) {
		throw new TypeError(`[workbench] ${api}.group: id has an invalid format`)
	}
	return id
}

function readWorkbenchIcon(value: unknown): WorkbenchIcon {
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

function requiredUtf8Text(api: string, field: string, value: unknown, maxBytes: number): string {
	const text = requiredText(api, field, value, maxBytes)
	if (new TextEncoder().encode(text).byteLength > maxBytes) {
		throw new TypeError(`[workbench] ${api}(): ${field} exceeds ${maxBytes} UTF-8 bytes`)
	}
	return text
}

function assertExactKeys(
	api: string,
	value: unknown,
	allowed: readonly string[],
): asserts value is Record<string, unknown> {
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
	const metadata = definitions.get(definition)
	if (!metadata) throw new TypeError('[workbench] invalid Workbench definition')
	return metadata
}

/** @internal Toolchain/server lowering only. */
export function readWorkbenchDescriptor(entry: WorkbenchEntry): WorkbenchDescriptorMetadata {
	const metadata = descriptors.get(entry)
	if (!metadata) throw new TypeError('[workbench] invalid entry descriptor')
	if (metadata === 'unbound')
		throw new TypeError('[workbench] descriptor is not owned by a Workbench definition')
	return metadata
}

/** @internal Runtime publication compiler only. */
export function readWorkbenchContentSlot(slot: WorkbenchContentSlot): WorkbenchContentSlotMetadata {
	return readContentSlotMetadata(slot)
}

export const workbench = Object.freeze({
	define,
	view,
	content,
	attachment,
	data,
	action,
})
