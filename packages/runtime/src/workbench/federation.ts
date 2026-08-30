import {
	createInstance,
	type ModuleFederation,
	type ModuleFederationRuntimePlugin,
} from '@module-federation/runtime'
import * as BridgeReact from '@module-federation/bridge-react/v19'
import {
	WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION,
	WORKBENCH_FEDERATION_RUNTIME_VERSION,
	WORKBENCH_FEDERATION_SHARE_STRATEGY,
	workbenchDeclarationIdentityEqual,
} from '@pluxel/core/federation'
import * as React from 'react'
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import { version as runtimeVersion } from '../../package.json'
import * as Workbench from '../workbench'
import type { RpcStub } from '../capnweb'
import * as WorkbenchClient from './client'
import {
	openWorkbenchView,
	type WorkbenchClientOpenResult,
	type WorkbenchOpenedViewHandle,
} from './client'
import type { WorkbenchLayoutEntry, WorkbenchSessionApi } from './client-protocol'
import * as WorkbenchReactInternal from './react-internal'
import * as WorkbenchReact from './react'
import {
	readWorkbenchBridgeIdentity,
	readWorkbenchBridgeProvider,
	type WorkbenchBridgeProvider,
} from './react-internal'
import type {
	WorkbenchBridgePayload,
	WorkbenchConfirmInput,
	WorkbenchDocumentTitle,
	WorkbenchHostFacade,
	WorkbenchNavigation,
	WorkbenchNotificationInput,
} from './react-context'
import type { WorkbenchPaneLayoutRenderer } from './ui-pane'

export { WorkbenchPaneLayoutControlsProvider } from './ui-pane'
export type {
	WorkbenchPaneDescriptor,
	WorkbenchPaneLayoutControls,
	WorkbenchPaneLayoutMode,
	WorkbenchPaneLayoutRenderer,
	WorkbenchPaneLayoutRendererProps,
} from './ui-pane'
export type {
	WorkbenchConfirmInput,
	WorkbenchDocumentTitle,
	WorkbenchHostFacade,
	WorkbenchNavigation,
	WorkbenchNotificationInput,
} from './react-context'

const FEDERATION_STATE = Symbol.for('pluxel.workbench.federation.profile1')
const BRIDGE_PAYLOAD_FIELD = '__pluxelWorkbench' as const

type FederationState = Readonly<{
	runtime: ModuleFederation
	remotes: Map<string, string>
}>

type WorkbenchBridgeApplication = ReturnType<WorkbenchBridgeProvider>

export type WorkbenchHostDocumentBindings = Readonly<{
	params: Readonly<Record<string, string>>
	setDirty(dirty: boolean): void
	setTitle(input: WorkbenchDocumentTitle): void
	reset(): void
}>

export type CreateWorkbenchViewHostInput = Readonly<{
	locale: string
	colorScheme: 'light' | 'dark'
	notify(input: WorkbenchNotificationInput): void
	confirm(input: WorkbenchConfirmInput): Promise<boolean>
	navigation?: WorkbenchNavigation
	document?: WorkbenchHostDocumentBindings
}>

/** Per-open host behavior scope, closed after Bridge destroy and before the Cap'n Web result. */
export class WorkbenchViewHostHandle implements Disposable {
	readonly facade: WorkbenchHostFacade
	readonly #scope = new AbortController()
	readonly #document?: WorkbenchHostDocumentBindings
	#locale: string
	#colorScheme: 'light' | 'dark'
	#active = true

	/** @internal Use `createWorkbenchViewHost()`. */
	constructor(input: CreateWorkbenchViewHostInput) {
		assertHostBindings(input)
		this.#locale = readLocale(input.locale)
		this.#colorScheme = readColorScheme(input.colorScheme)
		this.#document = input.document
		const navigation = input.navigation
			? Object.freeze({
					navigate: (path: string) => input.navigation!.navigate(readRelativePath(path)),
					openDocument: (value: { path: string; title: string; meta?: string }) =>
						input.navigation!.openDocument(
							Object.freeze({
								path: readRelativePath(value.path),
								title: readRequiredText(value.title, 'document title', 256),
								...(value.meta === undefined
									? {}
									: { meta: readRequiredText(value.meta, 'document meta', 256) }),
							}),
						),
				})
			: null
		const document = input.document
			? Object.freeze({
					params: freezeParams(input.document.params),
					setDirty: (dirty: boolean) => {
						this.#assertActive()
						if (typeof dirty !== 'boolean') {
							throw new TypeError('[workbench/federation] dirty must be boolean')
						}
						input.document!.setDirty(dirty)
					},
					setTitle: (value: WorkbenchDocumentTitle) => {
						this.#assertActive()
						input.document!.setTitle(
							Object.freeze({
								title: readRequiredText(value.title, 'document title', 256),
								...(value.meta === undefined
									? {}
									: { meta: readRequiredText(value.meta, 'document meta', 256) }),
							}),
						)
					},
				})
			: null

		const getLocale = () => this.#locale
		const getColorScheme = () => this.#colorScheme
		const assertActive = () => this.#assertActive()
		this.facade = Object.freeze({
			get locale() {
				return getLocale()
			},
			get colorScheme() {
				return getColorScheme()
			},
			notify(value: WorkbenchNotificationInput) {
				assertActive()
				input.notify(normalizeNotification(value))
			},
			confirm(value: WorkbenchConfirmInput) {
				assertActive()
				return Promise.resolve(input.confirm(normalizeConfirm(value))).then((confirmed) => {
					if (typeof confirmed !== 'boolean') {
						throw new TypeError('[workbench/federation] host confirm result must be boolean')
					}
					return confirmed
				})
			},
			navigation,
			document,
		})
	}

	get active(): boolean {
		return this.#active
	}

	updateAppearance(input: Readonly<{ locale: string; colorScheme: 'light' | 'dark' }>): void {
		this.#assertActive()
		this.#locale = readLocale(input.locale)
		this.#colorScheme = readColorScheme(input.colorScheme)
	}

	[Symbol.dispose](): void {
		if (!this.#active) return
		this.#active = false
		this.#scope.abort(new Error('Workbench View host closed'))
		if (this.#document) {
			try {
				this.#document.setDirty(false)
			} finally {
				this.#document.reset()
			}
		}
	}

	#assertActive(): void {
		if (!this.#active) throw this.#scope.signal.reason
	}
}

export function createWorkbenchViewHost(
	input: CreateWorkbenchViewHostInput,
): WorkbenchViewHostHandle {
	return new WorkbenchViewHostHandle(input)
}

export type OpenFederatedWorkbenchViewInput = Readonly<{
	session: RpcStub<WorkbenchSessionApi>
	entry: WorkbenchLayoutEntry
	layoutRevision: number
	location?: string
	dom: HTMLElement
	host: WorkbenchViewHostHandle
	paneLayoutRenderer?: WorkbenchPaneLayoutRenderer
}>

export type OpenFederatedWorkbenchViewResult =
	| Readonly<{ ok: true; view: FederatedWorkbenchView }>
	| Exclude<WorkbenchClientOpenResult, { ok: true }>

/** One exact MF Bridge application paired with one opened Cap'n Web result. */
export class FederatedWorkbenchView implements Disposable {
	readonly #application: WorkbenchBridgeApplication
	readonly #dom: HTMLElement
	readonly #moduleName: string
	readonly #opened: WorkbenchOpenedViewHandle
	readonly #host: WorkbenchViewHostHandle
	readonly #paneLayoutRenderer?: WorkbenchPaneLayoutRenderer
	#active = true

	/** @internal Created only after the first Bridge render succeeds. */
	constructor(input: {
		application: WorkbenchBridgeApplication
		dom: HTMLElement
		moduleName: string
		opened: WorkbenchOpenedViewHandle
		host: WorkbenchViewHostHandle
		paneLayoutRenderer?: WorkbenchPaneLayoutRenderer
	}) {
		this.#application = input.application
		this.#dom = input.dom
		this.#moduleName = input.moduleName
		this.#opened = input.opened
		this.#host = input.host
		this.#paneLayoutRenderer = input.paneLayoutRenderer
	}

	get active(): boolean {
		return this.#active
	}

	async update(): Promise<void> {
		this.#assertActive()
		await this.#application.render(this.#renderInfo())
	}

	[Symbol.dispose](): void {
		if (!this.#active) return
		this.#active = false
		let failure: unknown
		try {
			this.#application.destroy({ dom: this.#dom, moduleName: this.#moduleName })
		} catch (error) {
			failure = error
		}
		try {
			this.#host[Symbol.dispose]()
		} catch (error) {
			failure = combineFailures(failure, error)
		}
		try {
			this.#opened[Symbol.dispose]()
		} catch (error) {
			failure = combineFailures(failure, error)
		}
		if (failure) throw failure
	}

	#renderInfo(): RenderInfo {
		return {
			dom: this.#dom,
			moduleName: this.#moduleName,
			[BRIDGE_PAYLOAD_FIELD]: bridgePayload(this.#opened, this.#host, this.#paneLayoutRenderer),
		}
	}

	#assertActive(): void {
		if (!this.#active) throw new Error('Federated Workbench View is closed')
	}
}

type RenderInfo = Parameters<WorkbenchBridgeApplication['render']>[0] &
	Readonly<{ [BRIDGE_PAYLOAD_FIELD]: WorkbenchBridgePayload }>

/**
 * Profile 1's complete activation transaction: open exact roots, load the pinned Manifest expose,
 * validate the generated Bridge identity, and publish only after first render succeeds.
 */
export async function openFederatedWorkbenchView(
	input: OpenFederatedWorkbenchViewInput,
): Promise<OpenFederatedWorkbenchViewResult> {
	if (!(input.dom instanceof HTMLElement)) {
		throw new TypeError('[workbench/federation] dom must be an HTMLElement')
	}
	if (!(input.host instanceof WorkbenchViewHostHandle) || !input.host.active) {
		throw new TypeError('[workbench/federation] a fresh View host handle is required')
	}
	let opened: WorkbenchClientOpenResult
	try {
		opened = await openWorkbenchView(input.session, input.entry, {
			layoutRevision: input.layoutRevision,
			...(input.location === undefined ? {} : { location: input.location }),
		})
	} catch (error) {
		try {
			input.host[Symbol.dispose]()
		} catch (cleanupError) {
			throw combineFailures(error, cleanupError)
		}
		throw error
	}
	if (opened.ok === false) {
		input.host[Symbol.dispose]()
		return Object.freeze({ ok: false as const, code: opened.code })
	}

	const handle = opened.handle
	if (!input.host.active) {
		handle[Symbol.dispose]()
		throw new Error('[workbench/federation] View host closed during activation')
	}
	let application: WorkbenchBridgeApplication | undefined
	let moduleName = ''
	try {
		assertDocumentParams(input.host.facade, handle)
		const provider = await loadBridgeProvider(handle)
		if (!input.host.active) {
			throw new Error('[workbench/federation] View host closed during activation')
		}
		application = provider()
		if (
			!application ||
			typeof application.render !== 'function' ||
			typeof application.destroy !== 'function'
		) {
			throw new TypeError('[workbench/federation] Bridge provider returned an invalid application')
		}
		moduleName = `${handle.federatedViewRef.producer}/${handle.federatedViewRef.expose.slice(2)}`
		await application.render({
			dom: input.dom,
			moduleName,
			[BRIDGE_PAYLOAD_FIELD]: bridgePayload(handle, input.host, input.paneLayoutRenderer),
		})
		if (!input.host.active) {
			throw new Error('[workbench/federation] View host closed during activation')
		}
		return Object.freeze({
			ok: true as const,
			view: new FederatedWorkbenchView({
				application,
				dom: input.dom,
				moduleName,
				opened: handle,
				host: input.host,
				...(input.paneLayoutRenderer === undefined
					? {}
					: { paneLayoutRenderer: input.paneLayoutRenderer }),
			}),
		})
	} catch (error) {
		try {
			application?.destroy({ dom: input.dom, moduleName })
		} finally {
			try {
				input.host[Symbol.dispose]()
			} finally {
				handle[Symbol.dispose]()
			}
		}
		throw error
	}
}

/** Returns the page-global, host-owned MF Runtime. No caller can configure or replace it. */
export function getWorkbenchFederationRuntime(): ModuleFederation {
	return federationState().runtime
}

async function loadBridgeProvider(handle: WorkbenchOpenedViewHandle) {
	const ref = handle.federatedViewRef
	const state = federationState()
	const existing = state.remotes.get(ref.producer)
	if (existing === undefined) {
		state.runtime.registerRemotes([{ name: ref.producer, entry: ref.manifestUrl, type: 'module' }])
		state.remotes.set(ref.producer, ref.manifestUrl)
	} else if (existing !== ref.manifestUrl) {
		throw new Error(
			`[workbench/federation] producer ${ref.producer} changed revision inside one document`,
		)
	}
	const moduleName = `${ref.producer}/${ref.expose.slice(2)}`
	const remote = await state.runtime.loadRemote<{ default?: unknown }>(moduleName, {
		from: 'runtime',
	})
	if (!remote || typeof remote !== 'object' || !Object.hasOwn(remote, 'default')) {
		throw new TypeError(`[workbench/federation] ${moduleName} has no default Bridge export`)
	}
	const provider = readWorkbenchBridgeProvider(remote.default)
	const identity = readWorkbenchBridgeIdentity(provider)
	if (!workbenchDeclarationIdentityEqual(identity, ref.descriptor)) {
		throw new TypeError(`[workbench/federation] ${moduleName} descriptor identity mismatch`)
	}
	return provider
}

function federationState(): FederationState {
	const global = globalThis as typeof globalThis & Record<PropertyKey, unknown>
	const existing = global[FEDERATION_STATE]
	if (existing !== undefined) return existing as FederationState
	const state: FederationState = Object.freeze({
		runtime: createInstance({
			name: 'pluxel_workbench_profile1',
			remotes: [],
			shareStrategy: WORKBENCH_FEDERATION_SHARE_STRATEGY,
			shared: fixedShared(),
			plugins: [trustedWorkbenchRuntimePlugin()],
		}),
		remotes: new Map(),
	})
	global[FEDERATION_STATE] = state
	return state
}

function fixedShared() {
	return {
		react: sharedModule(React, React.version),
		'react/jsx-runtime': sharedModule(ReactJsxRuntime, React.version),
		'react/jsx-dev-runtime': sharedModule(ReactJsxDevRuntime, React.version),
		'react-dom': sharedModule(ReactDom, ReactDom.version),
		'react-dom/client': sharedModule(ReactDomClient, ReactDom.version),
		'@module-federation/bridge-react': sharedModule(
			BridgeReact,
			WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION,
		),
		'@pluxel/runtime/workbench': sharedModule(Workbench, runtimeVersion),
		'@pluxel/runtime/workbench/client': sharedModule(WorkbenchClient, runtimeVersion),
		'@pluxel/runtime/workbench/react': sharedModule(WorkbenchReact, runtimeVersion),
		'@pluxel/runtime/internal/workbench-react': sharedModule(
			WorkbenchReactInternal,
			runtimeVersion,
		),
	}
}

function sharedModule(module: unknown, version: string) {
	return {
		version,
		lib: () => module as any,
		shareConfig: {
			singleton: true,
			strictVersion: true,
			requiredVersion: version,
		},
	}
}

function trustedWorkbenchRuntimePlugin(): ModuleFederationRuntimePlugin {
	return {
		name: 'pluxel-workbench-profile1-policy',
		version: WORKBENCH_FEDERATION_RUNTIME_VERSION,
		async fetch(url, init) {
			const resolved = resolveSameOriginUrl(url)
			return await globalThis.fetch(resolved, { ...init, credentials: 'same-origin' })
		},
	}
}

function resolveSameOriginUrl(input: string): string {
	const origin = globalThis.location?.origin
	if (!origin) return input
	const url = new URL(input, origin)
	if (url.origin !== origin) {
		throw new TypeError('[workbench/federation] cross-origin artifact request rejected')
	}
	return url.href
}

function bridgePayload(
	handle: WorkbenchOpenedViewHandle,
	host: WorkbenchViewHostHandle,
	paneLayoutRenderer?: WorkbenchPaneLayoutRenderer,
): WorkbenchBridgePayload {
	return Object.freeze({
		profile: 1,
		handle,
		host: host.facade,
		...(paneLayoutRenderer === undefined ? {} : { paneLayoutRenderer }),
	})
}

function assertDocumentParams(host: WorkbenchHostFacade, handle: WorkbenchOpenedViewHandle): void {
	if (!host.document) return
	const actual = host.document.params
	const expected = handle.params
	const actualKeys = Object.keys(actual).sort()
	const expectedKeys = Object.keys(expected).sort()
	if (
		actualKeys.length !== expectedKeys.length ||
		actualKeys.some((key, index) => key !== expectedKeys[index] || actual[key] !== expected[key])
	) {
		throw new TypeError('[workbench/federation] document params do not match server-derived params')
	}
}

function freezeParams(input: Readonly<Record<string, string>>) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[workbench/federation] document params must be a record')
	}
	const output: Record<string, string> = Object.create(null)
	for (const [key, value] of Object.entries(input)) {
		if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') {
			throw new TypeError('[workbench/federation] invalid document params')
		}
		output[key] = value
	}
	return Object.freeze(output)
}

function readRelativePath(input: string): string {
	const value = readRequiredText(input, 'navigation path', 2048)
	if (
		!value.startsWith('/') ||
		value.startsWith('//') ||
		value.includes('\\') ||
		value.includes('?') ||
		value.includes('#')
	) {
		throw new TypeError('[workbench/federation] navigation path must be canonical and relative')
	}
	const normalized = new URL(value, 'https://pluxel.invalid').pathname
	if (normalized !== value) {
		throw new TypeError('[workbench/federation] navigation path must be canonical and relative')
	}
	return value
}

function readLocale(input: unknown): string {
	return readRequiredText(input, 'locale', 128)
}

function readColorScheme(input: unknown): 'light' | 'dark' {
	if (input !== 'light' && input !== 'dark') {
		throw new TypeError('[workbench/federation] colorScheme must be light or dark')
	}
	return input
}

function normalizeNotification(input: unknown): WorkbenchNotificationInput {
	const record = readExactInput(input, 'notification', ['title', 'message', 'tone'])
	if (
		record.tone !== undefined &&
		record.tone !== 'info' &&
		record.tone !== 'success' &&
		record.tone !== 'warning' &&
		record.tone !== 'error'
	) {
		throw new TypeError('[workbench/federation] notification tone is invalid')
	}
	return Object.freeze({
		...(record.title === undefined
			? {}
			: { title: readRequiredText(record.title, 'notification title', 256) }),
		message: readRequiredText(record.message, 'notification message', 4_096),
		...(record.tone === undefined ? {} : { tone: record.tone }),
	}) as WorkbenchNotificationInput
}

function assertHostBindings(input: unknown): asserts input is CreateWorkbenchViewHostInput {
	const record = readExactInput(input, 'View host input', [
		'locale',
		'colorScheme',
		'notify',
		'confirm',
		'navigation',
		'document',
	])
	if (typeof record.notify !== 'function' || typeof record.confirm !== 'function') {
		throw new TypeError('[workbench/federation] View host notify and confirm must be functions')
	}
	if (record.navigation !== undefined) {
		const navigation = record.navigation as Partial<WorkbenchNavigation>
		if (
			!navigation ||
			typeof navigation !== 'object' ||
			typeof navigation.navigate !== 'function' ||
			typeof navigation.openDocument !== 'function'
		) {
			throw new TypeError('[workbench/federation] View host navigation bindings are invalid')
		}
	}
	if (record.document !== undefined) {
		const document = record.document as Partial<WorkbenchHostDocumentBindings>
		if (
			!document ||
			typeof document !== 'object' ||
			typeof document.setDirty !== 'function' ||
			typeof document.setTitle !== 'function' ||
			typeof document.reset !== 'function'
		) {
			throw new TypeError('[workbench/federation] View host document bindings are invalid')
		}
	}
}

function normalizeConfirm(input: unknown): WorkbenchConfirmInput {
	const record = readExactInput(input, 'confirmation', [
		'title',
		'message',
		'confirmLabel',
		'cancelLabel',
		'tone',
	])
	if (record.tone !== undefined && record.tone !== 'default' && record.tone !== 'danger') {
		throw new TypeError('[workbench/federation] confirmation tone is invalid')
	}
	return Object.freeze({
		...(record.title === undefined
			? {}
			: { title: readRequiredText(record.title, 'confirmation title', 256) }),
		message: readRequiredText(record.message, 'confirmation message', 4_096),
		...(record.confirmLabel === undefined
			? {}
			: {
					confirmLabel: readRequiredText(record.confirmLabel, 'confirmation confirmLabel', 128),
				}),
		...(record.cancelLabel === undefined
			? {}
			: {
					cancelLabel: readRequiredText(record.cancelLabel, 'confirmation cancelLabel', 128),
				}),
		...(record.tone === undefined ? {} : { tone: record.tone }),
	}) as WorkbenchConfirmInput
}

function readExactInput(
	input: unknown,
	label: string,
	allowed: readonly string[],
): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[workbench/federation] ${label} must be an object`)
	}
	const record = input as Record<string, unknown>
	const extra = Object.keys(record).find((key) => !allowed.includes(key))
	if (extra !== undefined) {
		throw new TypeError(`[workbench/federation] ${label} includes unsupported field ${extra}`)
	}
	return record
}

function readRequiredText(input: unknown, label: string, max: number): string {
	if (typeof input !== 'string' || input.length === 0 || input.length > max) {
		throw new TypeError(`[workbench/federation] ${label} is invalid`)
	}
	return input
}

function combineFailures(first: unknown, second: unknown): unknown {
	return first === undefined
		? second
		: new AggregateError([first, second], 'Workbench cleanup failed')
}
