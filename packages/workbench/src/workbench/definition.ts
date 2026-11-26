import type { BasePlugin, PluginNodeAddress } from '@pluxel/core'
import type { GenericSchema, GenericSchemaAsync, InferOutput } from 'valibot'
import type { RpcTarget } from 'capnweb'
import type { WorkbenchEntryLink } from './client-protocol.ts'

import {
	assertExactKeys,
	isPlainRecord,
	parseWorkbenchPlacement,
	parseWorkbenchSourcePath,
	requiredUtf8Text,
	type WorkbenchPlacement,
	type WorkbenchPlacementInput,
} from './entry-options.ts'
export type {
	WorkbenchGroup,
	WorkbenchIcon,
	WorkbenchNavigation,
	WorkbenchPanelPlacement,
	WorkbenchPlacement,
	WorkbenchPlacementInput,
	WorkbenchRoutePlacement,
	WorkbenchTabPlacement,
} from './entry-options.ts'

const definitions = new WeakMap<object, WorkbenchDefinitionMetadata>()
const descriptors = new WeakMap<object, 'unbound' | WorkbenchDescriptorMetadata>()
const DATA_SLOT = Symbol('pluxel.workbench.content-data')
const ACTION_SLOT = Symbol('pluxel.workbench.content-action')
const canonicalContentSlots = new WeakSet<object>()

const ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/
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

type WorkbenchLinkKey<Definition extends AnyWorkbenchDefinition> = {
	[Key in keyof Definition & string]: Definition[Key] extends { readonly kind: 'attachment' }
		? never
		: Key
}[keyof Definition & string]

/** A handle to one Plugin generation's published definition. */
export interface WorkbenchPublication<Definition extends AnyWorkbenchDefinition> {
	/**
	 * Link to a tab or route on this node. For a parameterized route, supply
	 * the original string for each named segment. Tabs and static routes keep
	 * the entry key so links can follow changes to the declared path.
	 */
	link(
		key: WorkbenchLinkKey<Definition>,
		params?: Readonly<Record<string, string>>,
	): WorkbenchEntryLink
}

export interface PluginWorkbench {
	publish<const Definition extends AnyWorkbenchDefinition>(
		definition: Definition,
		...bindings: WorkbenchPublishBindings<Definition>
	): WorkbenchPublication<Definition>
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

function assertEntryKey(key: string): void {
	if (key.length > 128 || !ENTRY_KEY.test(key) || RESERVED_ENTRY_KEYS.has(key)) {
		throw new TypeError(`[workbench] define(): invalid entry key "${key}"`)
	}
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
