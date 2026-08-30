import { parsePluginNodeAddress } from '@pluxel/core'
import {
	parseWorkbenchDeclarationIdentity,
	parseWorkbenchOpenableIdentity,
	workbenchDeclarationIdentityEqual,
	type WorkbenchDeclarationIdentity,
	type WorkbenchOpenableIdentity,
} from '@pluxel/core/federation'
import type { RpcStub, RpcTarget } from '../capnweb'
import type {
	WorkbenchFederatedViewRef,
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchLayoutInput,
	WorkbenchOpenViewFailureCode,
	WorkbenchOpenViewInput,
	WorkbenchSessionApi,
} from './client-protocol'
import { readWorkbenchIcon, readWorkbenchRoutePath, type WorkbenchPlacement } from './definition'
import {
	createWorkbenchOpenedViewHandle,
	type WorkbenchOpenedClientValue,
	type WorkbenchOpenedState,
	type WorkbenchOpenedViewHandle,
} from './opened-view'

export { WorkbenchOpenedViewHandle, type WorkbenchOpenedClientValue } from './opened-view'

type DisposableValue = Readonly<{ [Symbol.dispose](): void }>

export type WorkbenchClientOpenResult =
	| Readonly<{ ok: true; handle: WorkbenchOpenedViewHandle }>
	| Readonly<{ ok: false; code: WorkbenchOpenViewFailureCode }>

/** Reads and validates a capability-free layout, releasing the Cap'n Web result immediately. */
export async function readWorkbenchLayout(
	session: RpcStub<WorkbenchSessionApi>,
	input: WorkbenchLayoutInput,
): Promise<WorkbenchLayout> {
	const result = await session.layout(input)
	try {
		return parseWorkbenchLayout(result)
	} finally {
		disposeValue(result)
	}
}

/**
 * Opens the exact tuple selected from a layout. A closed failure never returns a capability;
 * success transfers ownership of the single top-level RPC result to the returned handle.
 */
export async function openWorkbenchView(
	session: RpcStub<WorkbenchSessionApi>,
	entry: WorkbenchLayoutEntry,
	options: Readonly<{ layoutRevision: number; location?: string }>,
): Promise<WorkbenchClientOpenResult> {
	const canonicalEntry = parseWorkbenchLayoutEntry(entry, 'layout entry')
	const input: WorkbenchOpenViewInput = Object.freeze({
		layoutRevision: readRevision(options.layoutRevision, 'layoutRevision'),
		target: canonicalEntry.target.node,
		descriptor: canonicalEntry.descriptor,
		...(options.location === undefined
			? {}
			: { location: readBoundedText(options.location, 'location', 4096) }),
	})
	const result = await session.openView(input)
	let adopted = false
	try {
		const record = readExactRecord(result, 'openView result', ['ok', 'value', 'code'])
		if (record.ok === false) {
			if (Object.hasOwn(record, 'value')) malformed('openView failure includes value')
			const code = readFailureCode(record.code)
			return Object.freeze({ ok: false as const, code })
		}
		if (record.ok !== true || Object.hasOwn(record, 'code')) {
			malformed('openView result has an invalid discriminant')
		}
		const disposable = requireDisposable(result, 'successful openView result')
		const value = parseOpenedValue(record.value)
		assertOpenedMatchesLayout(value, canonicalEntry)
		const state: WorkbenchOpenedState = { active: true, result: disposable, value }
		const handle = createWorkbenchOpenedViewHandle(state)
		adopted = true
		return Object.freeze({ ok: true as const, handle })
	} finally {
		if (!adopted) disposeValue(result)
	}
}

export type RemoteValueSnapshot<Value> =
	| Readonly<{ state: 'loading' }>
	| Readonly<{ state: 'ready'; value: Value }>
	| Readonly<{ state: 'error'; error: unknown }>

export type RemoteValueOptions<Value> = Readonly<{
	/** Return a caller-owned local value; dispose any Cap'n Web result after copying its DTO fields. */
	read(): Value | PromiseLike<Value>
	subscribe?(invalidate: () => void): Disposable | PromiseLike<Disposable>
}>

export interface RemoteValue<Value> extends Disposable {
	getSnapshot(): RemoteValueSnapshot<Value>
	subscribe(listener: () => void): () => void
	refresh(): void
}

/**
 * Small client-side snapshot owner for Plugin-declared `read`/`watch` methods.
 * It is not a cache, query registry, reconnect layer, or wire protocol.
 */
export function createRemoteValue<Value>(options: RemoteValueOptions<Value>): RemoteValue<Value> {
	if (!options || typeof options.read !== 'function') {
		throw new TypeError('[workbench/client] createRemoteValue() requires read()')
	}
	const listeners = new Set<() => void>()
	let snapshot: RemoteValueSnapshot<Value> = Object.freeze({ state: 'loading' })
	let active = true
	let reading = false
	let invalidated = false
	let sequence = 0
	let subscription: Disposable | undefined
	let subscriptionPending: Disposable | undefined

	const publish = (next: RemoteValueSnapshot<Value>) => {
		if (!active) return
		snapshot = next
		const currentListeners = [...listeners]
		for (const listener of currentListeners) listener()
	}

	const readLatest = async () => {
		if (!active) return
		if (reading) {
			invalidated = true
			return
		}
		reading = true
		const current = ++sequence
		try {
			do {
				invalidated = false
				const value = await options.read()
				if (active && current === sequence && !invalidated) {
					publish(Object.freeze({ state: 'ready' as const, value }))
				}
			} while (active && invalidated && current === sequence)
		} catch (error) {
			if (active && current === sequence) {
				publish(Object.freeze({ state: 'error' as const, error }))
			}
		} finally {
			reading = false
		}
	}

	const invalidate = () => {
		if (!active) return
		if (reading) invalidated = true
		else void readLatest()
	}

	const start = async () => {
		try {
			if (options.subscribe) {
				const pending = options.subscribe(invalidate)
				subscriptionPending = isDisposable(pending) ? pending : undefined
				const settled = await pending
				if (!active) {
					if (subscriptionPending !== settled) disposeValue(settled)
					subscriptionPending = undefined
					return
				}
				if (!isDisposable(settled)) {
					throw new TypeError('[workbench/client] subscribe() must return a disposable')
				}
				subscription = settled
				subscriptionPending = undefined
			}
			await readLatest()
		} catch (error) {
			if (active) publish(Object.freeze({ state: 'error' as const, error }))
		}
	}

	void start()
	return Object.freeze({
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			if (!active) return () => {}
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		refresh: invalidate,
		[Symbol.dispose]() {
			if (!active) return
			active = false
			sequence += 1
			listeners.clear()
			disposeValue(subscription)
			if (subscriptionPending !== subscription) disposeValue(subscriptionPending)
			subscription = undefined
		},
	})
}

function parseWorkbenchLayout(input: unknown): WorkbenchLayout {
	const record = readExactRecord(input, 'layout', ['profile', 'revision', 'target', 'entries'])
	if (record.profile !== 1) malformed('layout profile is unsupported')
	if (!Array.isArray(record.entries)) malformed('layout entries must be an array')
	const entries = record.entries.map((entry, index) =>
		parseWorkbenchLayoutEntry(entry, `layout.entries[${index}]`),
	)
	return Object.freeze({
		profile: 1,
		revision: readRevision(record.revision, 'layout.revision'),
		target: record.target === null ? null : parseLayoutTarget(record.target, 'layout.target'),
		entries: Object.freeze(entries),
	})
}

function parseWorkbenchLayoutEntry(input: unknown, label: string): WorkbenchLayoutEntry {
	const record = readExactRecord(input, label, [
		'descriptor',
		'target',
		'renderer',
		'definitionRevisions',
		'placement',
		'federatedViewRef',
	])
	const descriptor = parseWorkbenchOpenableIdentity(record.descriptor)
	const target = parseLayoutTarget(record.target, `${label}.target`)
	const revisions = readExactRecord(record.definitionRevisions, `${label}.definitionRevisions`, [
		'target',
		'renderer',
	])
	const federatedViewRef = parseFederatedViewRef(record.federatedViewRef)
	const declaration = rendererDeclaration(descriptor)
	if (!workbenchDeclarationIdentityEqual(federatedViewRef.descriptor, declaration)) {
		malformed(`${label} renderer declaration does not match its federated ref`)
	}
	return Object.freeze({
		descriptor,
		target,
		renderer: parsePluginNodeAddress(record.renderer),
		definitionRevisions: Object.freeze({
			target: readRevision(revisions.target, `${label}.definitionRevisions.target`),
			renderer: readRevision(revisions.renderer, `${label}.definitionRevisions.renderer`),
		}),
		placement: parsePlacement(record.placement, `${label}.placement`),
		federatedViewRef,
	})
}

function parseOpenedValue(input: unknown): WorkbenchOpenedClientValue {
	const record = readRecord(input, 'opened View')
	if (record.kind === 'local') {
		assertExactKeys(record, 'opened local View', ['kind', 'api', 'params', 'federatedViewRef'])
		const ref = parseFederatedViewRef(record.federatedViewRef)
		if (ref.descriptor.kind !== 'view') malformed('local View ref must identify a View')
		return Object.freeze({
			kind: 'local',
			api: readStub(record.api, 'opened local View api'),
			params: parseParams(record.params),
			federatedViewRef: ref,
		})
	}
	if (record.kind === 'attachment') {
		assertExactKeys(record, 'opened Attachment', [
			'kind',
			'provider',
			'consumer',
			'params',
			'federatedViewRef',
		])
		const ref = parseFederatedViewRef(record.federatedViewRef)
		if (ref.descriptor.kind !== 'attachment') {
			malformed('Attachment ref must identify its provider declaration')
		}
		return Object.freeze({
			kind: 'attachment',
			provider: readStub(record.provider, 'opened Attachment provider'),
			...(record.consumer === undefined
				? {}
				: { consumer: readStub(record.consumer, 'opened Attachment consumer') }),
			params: parseParams(record.params),
			federatedViewRef: ref,
		})
	}
	malformed('opened View kind is unsupported')
}

function assertOpenedMatchesLayout(
	opened: WorkbenchOpenedClientValue,
	entry: WorkbenchLayoutEntry,
): void {
	const expected = entry.federatedViewRef
	const actual = opened.federatedViewRef
	if (
		actual.profile !== expected.profile ||
		actual.producer !== expected.producer ||
		actual.buildRevision !== expected.buildRevision ||
		actual.manifestUrl !== expected.manifestUrl ||
		actual.expose !== expected.expose ||
		!workbenchDeclarationIdentityEqual(actual.descriptor, expected.descriptor)
	) {
		malformed('opened View federation tuple does not match the selected layout entry')
	}
	if (entry.descriptor.kind === 'view') {
		if (opened.kind !== 'local') malformed('View declaration returned an Attachment root')
		if (!workbenchDeclarationIdentityEqual(entry.descriptor, actual.descriptor)) {
			malformed('opened View declaration does not match the selected layout descriptor')
		}
		return
	}
	if (opened.kind !== 'attachment') malformed('Attachment placement returned a local View root')
	if (!workbenchDeclarationIdentityEqual(entry.descriptor.provider, actual.descriptor)) {
		malformed('opened Attachment provider does not match the selected placement')
	}
}

function parseFederatedViewRef(input: unknown): WorkbenchFederatedViewRef {
	const record = readExactRecord(input, 'federated View ref', [
		'profile',
		'producer',
		'buildRevision',
		'manifestUrl',
		'expose',
		'descriptor',
	])
	if (record.profile !== 1) malformed('federated View profile is unsupported')
	const producer = readPatternText(
		record.producer,
		'federated View producer',
		/^[A-Za-z][A-Za-z0-9_-]{0,127}$/,
	)
	const buildRevision = readPatternText(
		record.buildRevision,
		'federated View buildRevision',
		/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
	)
	const manifestUrl = readBoundedText(record.manifestUrl, 'federated View manifestUrl', 2048)
	if (
		!manifestUrl.startsWith('/') ||
		manifestUrl.startsWith('//') ||
		manifestUrl.includes('?') ||
		manifestUrl.includes('#') ||
		!manifestUrl.endsWith('/mf-manifest.json')
	) {
		malformed('federated View manifestUrl must be an immutable same-origin path')
	}
	const expose = readPatternText(
		record.expose,
		'federated View expose',
		/^\.\/views\/[A-Za-z][A-Za-z0-9_-]{0,127}$/,
	) as `./views/${string}`
	return Object.freeze({
		profile: 1,
		producer,
		buildRevision,
		manifestUrl,
		expose,
		descriptor: parseWorkbenchDeclarationIdentity(record.descriptor),
	})
}

function rendererDeclaration(descriptor: WorkbenchOpenableIdentity): WorkbenchDeclarationIdentity {
	return descriptor.kind === 'view' ? descriptor : descriptor.provider
}

function parseLayoutTarget(input: unknown, label: string) {
	const record = readExactRecord(input, label, ['node', 'displayName'])
	return Object.freeze({
		node: parsePluginNodeAddress(record.node),
		displayName: readBoundedText(record.displayName, `${label}.displayName`, 256),
	})
}

function parsePlacement(input: unknown, label: string): WorkbenchPlacement {
	const record = readRecord(input, label)
	if (record.kind === 'tab') {
		assertExactKeys(record, label, ['kind', 'label', 'icon', 'group', 'order'])
		return Object.freeze({
			kind: 'tab',
			...(record.label === undefined
				? {}
				: { label: readBoundedText(record.label, `${label}.label`, 256) }),
			...(record.icon === undefined ? {} : { icon: readWorkbenchIcon(record.icon) }),
			...(record.group === undefined ? {} : { group: parseGroup(record.group, `${label}.group`) }),
			order: readFiniteNumber(record.order, `${label}.order`),
		})
	}
	if (record.kind === 'route') {
		assertExactKeys(record, label, [
			'kind',
			'path',
			'title',
			'icon',
			'navigation',
			'frame',
			'order',
		])
		if (record.frame !== 'shell' && record.frame !== 'standalone') {
			malformed(`${label}.frame is invalid`)
		}
		return Object.freeze({
			kind: 'route',
			path: readWorkbenchRoutePath(record.path),
			title: readBoundedText(record.title, `${label}.title`, 256),
			...(record.icon === undefined ? {} : { icon: readWorkbenchIcon(record.icon) }),
			...(record.navigation === undefined
				? {}
				: { navigation: parseNavigation(record.navigation, `${label}.navigation`) }),
			frame: record.frame,
			order: readFiniteNumber(record.order, `${label}.order`),
		})
	}
	malformed(`${label}.kind is unsupported`)
}

function parseNavigation(input: unknown, label: string) {
	const record = readExactRecord(input, label, ['label', 'group'])
	return Object.freeze({
		label: readBoundedText(record.label, `${label}.label`, 256),
		...(record.group === undefined ? {} : { group: parseGroup(record.group, `${label}.group`) }),
	})
}

function parseGroup(input: unknown, label: string) {
	const record = readExactRecord(input, label, ['id', 'label', 'icon'])
	return Object.freeze({
		id: readPatternText(record.id, `${label}.id`, /^[A-Za-z][A-Za-z0-9._-]{0,63}$/),
		label: readBoundedText(record.label, `${label}.label`, 256),
		...(record.icon === undefined ? {} : { icon: readWorkbenchIcon(record.icon) }),
	})
}

function parseParams(input: unknown): Readonly<Record<string, string>> {
	const record = readRecord(input, 'opened View params')
	const output: Record<string, string> = Object.create(null)
	for (const [key, value] of Object.entries(record)) {
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) malformed('opened View param name is invalid')
		output[key] = readBoundedText(value, `opened View params.${key}`, 2048)
	}
	return Object.freeze(output)
}

function readFailureCode(input: unknown): WorkbenchOpenViewFailureCode {
	if (
		input !== 'layout_changed' &&
		input !== 'target_unavailable' &&
		input !== 'factory_failed' &&
		input !== 'factory_timeout' &&
		input !== 'quota_exceeded'
	) {
		malformed('openView failure code is unsupported')
	}
	return input
}

function readStub(input: unknown, label: string): RpcStub<RpcTarget> {
	if ((typeof input !== 'object' && typeof input !== 'function') || input === null) {
		malformed(`${label} is not a capability`)
	}
	if (!isDisposable(input)) malformed(`${label} is not disposable`)
	return input as RpcStub<RpcTarget>
}

function requireDisposable(input: unknown, label: string): DisposableValue {
	if (!isDisposable(input)) malformed(`${label} is not disposable`)
	return input
}

function isDisposable(input: unknown): input is DisposableValue {
	return (
		(typeof input === 'object' || typeof input === 'function') &&
		input !== null &&
		typeof (input as Partial<DisposableValue>)[Symbol.dispose] === 'function'
	)
}

function disposeValue(input: unknown): void {
	if (isDisposable(input)) input[Symbol.dispose]()
}

function readRevision(input: unknown, label: string): number {
	if (!Number.isSafeInteger(input) || (input as number) < 0) malformed(`${label} is invalid`)
	return input as number
}

function readFiniteNumber(input: unknown, label: string): number {
	if (typeof input !== 'number' || !Number.isFinite(input)) malformed(`${label} is invalid`)
	return input
}

function readBoundedText(input: unknown, label: string, max: number): string {
	if (typeof input !== 'string' || input.length === 0 || input.length > max) {
		malformed(`${label} is invalid`)
	}
	return input
}

function readPatternText(input: unknown, label: string, pattern: RegExp): string {
	const value = readBoundedText(input, label, 2048)
	if (!pattern.test(value)) malformed(`${label} is invalid`)
	return value
}

function readRecord(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		malformed(`${label} must be an object`)
	return input as Record<string, unknown>
}

function readExactRecord(input: unknown, label: string, allowed: readonly string[]) {
	const record = readRecord(input, label)
	assertExactKeys(record, label, allowed)
	return record
}

function assertExactKeys(
	record: Record<string, unknown>,
	label: string,
	allowed: readonly string[],
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) malformed(`${label} includes unsupported field ${key}`)
	}
}

function malformed(message: string): never {
	throw new TypeError(`[workbench/client] ${message}`)
}

export type {
	WorkbenchFederatedViewRef,
	WorkbenchLayout,
	WorkbenchLayoutEntry,
	WorkbenchLayoutInput,
	WorkbenchLayoutTarget,
	WorkbenchOpenedAttachment,
	WorkbenchOpenedLocalView,
	WorkbenchOpenedView,
	WorkbenchOpenViewFailureCode,
	WorkbenchOpenViewInput,
	WorkbenchOpenViewResult,
	WorkbenchSessionApi,
} from './client-protocol'
