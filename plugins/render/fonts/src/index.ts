import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { GlobalFonts, type FontKey } from '@napi-rs/canvas'
import { BasePlugin, Plugin, type Context, type PersistenceNamespace } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { FontsConfig, type FontsPluginConfig } from './config.ts'
import { FontsError, type FontsErrorCode } from './errors.ts'
import { FontTaskScheduler, type FontTaskSchedulerOwner } from './font-task-scheduler.ts'
import {
	decodeManagedFont,
	encodeManagedFont,
	MANAGED_FONT_RECORD_OVERHEAD_LIMIT,
	managedFontId,
	managedFontKey,
	toManagedFontSnapshot,
	type StoredManagedFont,
} from './managed-record.ts'
import type {
	FontsManagerSnapshot,
	FontsWorkbenchCommands,
	InstallManagedFontInput,
	ManagedFontSnapshot,
} from './manager-contract.ts'
import type {
	DefaultFontSnapshot,
	FontSelectionCommands,
	FontSelectionSnapshot,
	FontFamilySnapshot,
} from './workbench-contract.ts'
import { FontsWorkbench } from './workbench-extension.ts'

const STORAGE_NAMESPACE = '@pluxel/fonts'
const DEFAULT_FONT_KEY = 'settings/default-font.json'
const MANAGED_ID = /^[A-Za-z0-9_-]{43}$/
const MAX_FILE_NAME_LENGTH = 255
const MAX_FAMILY_LENGTH = 128
const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace'])
let nativeRegistryRevision = 0

export type FontRegistrationInput = Readonly<{
	/** Borrowed until registration settles; the plugin snapshots it cooperatively. */
	data: Uint8Array
	/** Optional family alias used by CSS canvas font strings. */
	family?: string
	/** Cancels byte snapshotting or file IO; native registration already in progress cannot stop. */
	signal?: AbortSignal
}>

export type FontPathRegistrationInput = Readonly<{
	/** Absolute server path read asynchronously before registration. */
	path: string
	/** Optional family alias used by CSS canvas font strings. */
	family?: string
	/** Cancels file IO; native registration already in progress cannot stop. */
	signal?: AbortSignal
}>

export interface FontRegistration {
	/** Family names added or changed by this registration. */
	readonly families: readonly string[]
	readonly active: boolean
	/** Removes this registration. Repeated calls are harmless. */
	dispose(): void
}

/** Metadata for font bytes that can be replayed into a renderer-local registry. */
export type PortableFontResourceSnapshot = Readonly<{
	/** Content-addressed identity for the bytes and optional family override. */
	id: string
	/** Requested family override. Omitted when the font's embedded metadata is authoritative. */
	family?: string
	/** Families observed when the resource entered the native Canvas registry. */
	resolvedFamilies: readonly string[]
	byteLength: number
}>

/** Frozen metadata snapshot; resource bytes are read separately to avoid copying on every poll. */
export type PortableFontsSnapshot = Readonly<{
	/** Changes only when the replayable resource set changes. */
	revision: number
	fonts: readonly PortableFontResourceSnapshot[]
}>

/** Candidate projection used by a Fonts Selection Port outlet. */
export type FontSelectionScope = 'all' | 'portable'

type OwnedRegistration = Readonly<{
	key: FontKey
	owner: Context
	handle: FontRegistrationHandle
	portableId: string
	byteLength: number
}>

type PortableFontSource = Readonly<{
	id: string
	family?: string
	data: Uint8Array
}>

type PortableFontEntry = {
	readonly source: PortableFontSource
	resolvedFamilies: readonly string[]
	registrations: number
}

type PortableFontsState = {
	readonly entries: Map<string, PortableFontEntry>
	revision: number
	cached?: PortableFontsSnapshot
}

type NativeRegistrationBudget = {
	bytes: number
}

function attachPortableFont(
	state: PortableFontsState,
	source: PortableFontSource,
	resolvedFamilies: readonly string[],
): void {
	const existing = state.entries.get(source.id)
	if (existing) {
		existing.registrations += 1
		const merged = Object.freeze(
			[...new Set([...existing.resolvedFamilies, ...resolvedFamilies])].toSorted(),
		)
		if (
			merged.length !== existing.resolvedFamilies.length ||
			merged.some((family, index) => family !== existing.resolvedFamilies[index])
		) {
			existing.resolvedFamilies = merged
			state.revision += 1
			state.cached = undefined
		}
		return
	}
	state.entries.set(source.id, {
		source,
		resolvedFamilies: Object.freeze([...resolvedFamilies]),
		registrations: 1,
	})
	state.revision += 1
	state.cached = undefined
}

function detachPortableFont(state: PortableFontsState, id: string): void {
	const existing = state.entries.get(id)
	if (!existing) return
	existing.registrations -= 1
	if (existing.registrations > 0) return
	state.entries.delete(id)
	state.revision += 1
	state.cached = undefined
}

function releaseOwnedRegistration(
	registrations: Set<OwnedRegistration>,
	registrationsByOwner: WeakMap<Context, Set<OwnedRegistration>>,
	portableFonts: PortableFontsState,
	nativeBudget: NativeRegistrationBudget,
	registration: OwnedRegistration,
): void {
	if (!registration.handle.active) return
	registration.handle.deactivate()
	registrations.delete(registration)
	registrationsByOwner.get(registration.owner)?.delete(registration)
	GlobalFonts.remove(registration.key)
	detachPortableFont(portableFonts, registration.portableId)
	nativeBudget.bytes -= registration.byteLength
	nativeRegistryRevision += 1
}

type ManagedRuntimeFont = Readonly<{
	stored: StoredManagedFont
	snapshot: ManagedFontSnapshot
	registration: OwnedRegistration
}>

type FontsGeneration = Readonly<{
	scheduler: FontTaskScheduler
}>

type FontsOwnerLease = Readonly<{
	owner: Context
	generation: FontsGeneration
	controller: AbortController
	schedulerOwner: FontTaskSchedulerOwner
	state: { active: boolean }
}>

type ManagedState = {
	readonly owner: Context
	readonly storage: PersistenceNamespace
	readonly prefix: string
	readonly fonts: Map<string, ManagedRuntimeFont>
	active: boolean
	pendingTasks: number
	tail: Promise<void>
}

type DefaultFontState = {
	readonly systemFamilies: Set<string>
	configuredFamily?: string
	workbenchFamily?: string
	storage?: PersistenceNamespace
	resolvedDefault?: Readonly<{ revision: number; snapshot: DefaultFontSnapshot }>
	resolvedFamilies?: Readonly<{ revision: number; snapshot: readonly FontFamilySnapshot[] }>
	tail: Promise<void>
}

@Plugin()
export class FontsPlugin extends BasePlugin {
	private readonly config = this.configs.use(FontsConfig)
	private readonly registrations = new Set<OwnedRegistration>()
	private readonly registrationsByOwner = new WeakMap<Context, Set<OwnedRegistration>>()
	private readonly leases = new Set<FontsOwnerLease>()
	private readonly ownerLeases = new WeakMap<Context, FontsOwnerLease>()
	private readonly portableFontsState: PortableFontsState = {
		entries: new Map(),
		revision: 0,
	}
	private readonly nativeBudget: NativeRegistrationBudget = { bytes: 0 }
	private readonly defaults: DefaultFontState = {
		systemFamilies: new Set(),
		tail: Promise.resolve(),
	}
	private managed?: ManagedState
	private generation?: FontsGeneration
	private running = false
	private lifecycleRevision = 0

	override async init(): Promise<void> {
		if (this.config.maxQueuedFontTasksPerConsumer > this.config.maxQueuedFontTasks) {
			throw new FontsError(
				'INVALID_INPUT',
				'maxQueuedFontTasksPerConsumer must not exceed maxQueuedFontTasks',
			)
		}
		this.lifecycleRevision += 1
		const storage = this.ctx.root.persistence.namespace(STORAGE_NAMESPACE)
		const systemFamilies = new Set(GlobalFonts.families.map(({ family }) => family))
		const configuredDefaultFamily =
			this.config.defaultFamily === undefined
				? undefined
				: normalizeFamily(this.config.defaultFamily)
		const workbenchDefaultFamily = await loadDefaultFamily(storage)
		this.defaults.systemFamilies.clear()
		for (const family of systemFamilies) this.defaults.systemFamilies.add(family)
		this.defaults.configuredFamily = configuredDefaultFamily
		this.defaults.workbenchFamily = workbenchDefaultFamily
		this.defaults.storage = storage
		this.defaults.resolvedDefault = undefined
		this.defaults.resolvedFamilies = undefined
		nativeRegistryRevision += 1
		const generation: FontsGeneration = Object.freeze({
			scheduler: new FontTaskScheduler(
				this.config.maxConcurrentFontTasks,
				this.config.maxQueuedFontTasks,
				this.config.maxQueuedFontTasksPerConsumer,
			),
		})
		this.generation = generation
		this.running = true
		this.ctx.effects.defer(
			async () => {
				const stopped = new FontsError(
					'NOT_RUNNING',
					'Fonts capability belongs to a stopped plugin generation',
				)
				if (this.generation === generation) {
					this.generation = undefined
					this.running = false
					this.lifecycleRevision += 1
				}
				const managed = this.managed
				if (managed) managed.active = false
				for (const lease of this.leases) {
					if (lease.generation === generation) this.closeOwnerLease(lease, stopped)
				}
				await Promise.allSettled([
					generation.scheduler.close(stopped),
					managed?.tail ?? Promise.resolve(),
					this.defaults.tail,
				])
				this.defaults.configuredFamily = undefined
				this.defaults.workbenchFamily = undefined
				this.defaults.storage = undefined
				this.defaults.resolvedDefault = undefined
				this.defaults.resolvedFamilies = undefined
				this.defaults.systemFamilies.clear()
				if (managed) {
					managed.fonts.clear()
					if (this.managed === managed) this.managed = undefined
				}
				const active = [...this.registrations]
				this.registrations.clear()
				for (const registration of active) {
					this.registrationsByOwner.get(registration.owner)?.delete(registration)
					registration.handle.deactivate()
				}
				if (active.length > 0) {
					GlobalFonts.removeBatch(active.map(({ key }) => key))
					this.nativeBudget.bytes = 0
					nativeRegistryRevision += 1
				}
				if (this.portableFontsState.entries.size > 0) {
					this.portableFontsState.entries.clear()
					this.portableFontsState.revision += 1
					this.portableFontsState.cached = undefined
				}
			},
			{ tag: 'fonts-registry' },
		)
		this.managed = await this.initializeManagedFonts(storage)
		this.ctx.workbench?.mount(FontsWorkbench, {
			fonts: workbench.bind.rpc(() => this.createWorkbenchManager()),
		})
	}

	/** Registers font bytes for the current caller generation. */
	async register(input: FontRegistrationInput): Promise<FontRegistration> {
		const lifecycleRevision = this.requireLifecycleRevision()
		if (!input || !(input.data instanceof Uint8Array)) {
			throw new FontsError('INVALID_INPUT', 'Font data must be a Uint8Array')
		}
		const signal = normalizeSignal(input.signal)
		const family = normalizeFamily(input.family)
		this.assertFontSize(input.data.byteLength)
		const ownerLease = this.requireOwnerLease()
		this.assertOwnerCapacity(ownerLease.owner)
		return this.runFontTask(ownerLease, signal, async (activeSignal) => {
			this.assertLifecycleRevision(lifecycleRevision)
			this.assertOwnerLease(ownerLease)
			this.assertOwnerCapacity(ownerLease.owner)
			const data = await snapshotBytes(input.data, activeSignal)
			const id = await managedFontId(data, family, activeSignal)
			if (activeSignal.aborted) {
				throw abortReason(activeSignal, 'Font registration aborted')
			}
			this.assertLifecycleRevision(lifecycleRevision)
			this.assertOwnerLease(ownerLease)
			return this.registerBytes(ownerLease.owner, data, id, family).handle
		})
	}

	/** Registers one font from an absolute server path for the current caller generation. */
	async registerFromPath(input: FontPathRegistrationInput): Promise<FontRegistration> {
		const lifecycleRevision = this.requireLifecycleRevision()
		if (!input || typeof input.path !== 'string' || !isAbsolute(input.path)) {
			throw new FontsError('INVALID_INPUT', 'Font path must be an absolute server path')
		}
		const signal = normalizeSignal(input.signal)
		if (signal?.aborted) throw abortReason(signal, 'Font registration aborted')
		const family = normalizeFamily(input.family)
		const ownerLease = this.requireOwnerLease()
		this.assertOwnerCapacity(ownerLease.owner)
		return this.runFontTask(ownerLease, signal, async (activeSignal) => {
			this.assertLifecycleRevision(lifecycleRevision)
			this.assertOwnerLease(ownerLease)
			this.assertOwnerCapacity(ownerLease.owner)
			let data: Buffer
			try {
				data = await readBoundedFontFile(input.path, this.config.maxFontBytes, activeSignal)
			} catch (cause) {
				if (activeSignal.aborted) {
					throw abortReason(activeSignal, 'Font registration aborted')
				}
				if (cause instanceof FontsError) throw cause
				throw new FontsError('INVALID_INPUT', `Cannot read font file at ${input.path}`, { cause })
			}
			this.assertFontSize(data.byteLength)
			const id = await managedFontId(data, family, activeSignal)
			if (activeSignal.aborted) {
				throw abortReason(activeSignal, 'Font registration aborted')
			}
			this.assertLifecycleRevision(lifecycleRevision)
			this.assertOwnerLease(ownerLease)
			return this.registerBytes(ownerLease.owner, data, id, family).handle
		})
	}

	/** Returns a detached snapshot of every family visible to the native renderer. */
	get families(): readonly FontFamilySnapshot[] {
		this.assertRunning()
		return this.resolveFamilies()
	}

	/** Provider-wide default resolved from Workbench, config, system discovery, then generic CSS. */
	get defaultFont(): DefaultFontSnapshot {
		this.assertRunning()
		return this.resolveDefaultFont()
	}

	/** Process-local revision for FontsPlugin-managed registry or default-selection changes. */
	get revision(): number {
		this.assertRunning()
		return nativeRegistryRevision
	}

	/**
	 * Returns frozen metadata for managed and caller-registered font bytes. Platform-discovered
	 * system fonts are intentionally absent because their files are not owned by FontsPlugin.
	 */
	get portableFonts(): PortableFontsSnapshot {
		this.assertRunning()
		const state = this.portableFontsState
		if (state.cached?.revision === state.revision) return state.cached
		const snapshot = Object.freeze({
			revision: state.revision,
			fonts: Object.freeze(
				[...state.entries.values()]
					.map(({ source, resolvedFamilies }) =>
						Object.freeze({
							id: source.id,
							...(source.family ? { family: source.family } : {}),
							resolvedFamilies,
							byteLength: source.data.byteLength,
						}),
					)
					.toSorted((left, right) => left.id.localeCompare(right.id)),
			),
		})
		state.cached = snapshot
		return snapshot
	}

	/** Returns a detached byte copy for one ID from the current `portableFonts` snapshot. */
	async readPortableFont(
		id: string,
		options: Readonly<{ signal?: AbortSignal }> = {},
	): Promise<Uint8Array> {
		const lifecycleRevision = this.requireLifecycleRevision()
		const ownerLease = this.requireOwnerLease()
		if (!options || typeof options !== 'object') {
			throw new FontsError('INVALID_INPUT', 'Portable font read options must be an object')
		}
		const signal = normalizeSignal(options.signal)
		if (typeof id !== 'string' || !MANAGED_ID.test(id)) {
			throw new FontsError('INVALID_INPUT', 'Portable font ID is invalid')
		}
		return this.runFontTask(ownerLease, signal, async (activeSignal) => {
			this.assertLifecycleRevision(lifecycleRevision)
			this.assertOwnerLease(ownerLease)
			const source = this.portableFontsState.entries.get(id)?.source
			if (!source) throw new FontsError('FONT_NOT_FOUND', `Portable font ${id} does not exist`)
			const snapshot = await snapshotBytes(source.data, activeSignal)
			this.assertLifecycleRevision(lifecycleRevision)
			this.assertOwnerLease(ownerLease)
			if (this.portableFontsState.entries.get(id)?.source !== source) {
				throw new FontsError('FONT_NOT_FOUND', `Portable font ${id} no longer exists`)
			}
			return snapshot
		})
	}

	private createWorkbenchManager(): RpcTarget & FontsWorkbenchCommands {
		this.assertRunning()
		const state = this.managed
		if (!state?.active) {
			throw new FontsError('NOT_RUNNING', 'Managed font collection is not available')
		}
		return new FontsManagerRpc(
			() => this.readManagedSnapshot(state),
			(family) => this.setWorkbenchDefaultFamily(state, family),
			(input) => this.installManagedFont(state, input),
			(id) => this.removeManagedFont(state, id),
		)
	}

	/** Returns the provider-owned default selector used by `FontsSelectionPort` outlets. */
	selectionManager(scope: FontSelectionScope = 'all'): RpcTarget & FontSelectionCommands {
		this.assertRunning()
		if (scope !== 'all' && scope !== 'portable') {
			throw new FontsError('INVALID_INPUT', 'Font selection scope must be all or portable')
		}
		const state = this.managed
		if (!state?.active) {
			throw new FontsError('NOT_RUNNING', 'Managed font collection is not available')
		}
		const portable = scope === 'portable'
		return new FontSelectionRpc(
			async () =>
				toSelectionSnapshot(
					await this.readManagedSnapshot(state),
					portable ? portableFamilyKeys(this.portableFontsState) : undefined,
				),
			async (family) =>
				toSelectionSnapshot(
					await this.setWorkbenchDefaultFamily(
						state,
						family,
						portable
							? (selected) =>
									portableFamilyKeys(this.portableFontsState).has(
										selected.toLocaleLowerCase('en-US'),
									)
							: undefined,
					),
					portable ? portableFamilyKeys(this.portableFontsState) : undefined,
				),
		)
	}

	private async initializeManagedFonts(storage: PersistenceNamespace): Promise<ManagedState> {
		const state: ManagedState = {
			owner: this.ctx,
			storage,
			prefix: 'managed',
			fonts: new Map(),
			active: true,
			pendingTasks: 0,
			tail: Promise.resolve(),
		}
		try {
			for await (const entry of state.storage.list(state.prefix)) {
				if (entry.kind !== 'file' || !entry.key.endsWith('.font')) continue
				if (state.fonts.size >= this.config.maxManagedFonts) {
					throw new FontsError(
						'FONT_LIMIT_EXCEEDED',
						`Managed font collection exceeds its ${this.config.maxManagedFonts} font limit`,
					)
				}
				const id = entry.key.slice(state.prefix.length + 1, -'.font'.length)
				if (!MANAGED_ID.test(id)) {
					throw new FontsError('CORRUPT_FONT_STORAGE', `Managed font key is invalid: ${entry.key}`)
				}
				const value = await state.storage.get(entry.key)
				if (!value) {
					throw new FontsError('CORRUPT_FONT_STORAGE', `Managed font disappeared: ${entry.key}`)
				}
				if (value.byteLength > this.config.maxFontBytes + MANAGED_FONT_RECORD_OVERHEAD_LIMIT) {
					throw new FontsError(
						'FONT_TOO_LARGE',
						`Managed font record exceeds the configured ${this.config.maxFontBytes} font byte limit`,
					)
				}
				let stored: StoredManagedFont
				try {
					await new Promise<void>((resolve) => setImmediate(resolve))
					stored = await decodeManagedFont(value, id)
				} catch (cause) {
					throw new FontsError('CORRUPT_FONT_STORAGE', `Managed font is corrupt: ${entry.key}`, {
						cause,
					})
				}
				this.assertFontSize(stored.byteLength)
				this.assertManagedStateActive(state)
				const registration = this.registerBytes(
					state.owner,
					stored.data,
					stored.id,
					stored.family,
					false,
				)
				const snapshot = toManagedFontSnapshot(stored, registration.handle.families)
				state.fonts.set(id, { stored, snapshot, registration })
			}
			this.assertManagedStateActive(state)
			return state
		} catch (error) {
			state.active = false
			for (const font of state.fonts.values()) this.releaseRegistration(font.registration)
			state.fonts.clear()
			throw error
		}
	}

	private readManagedSnapshot(state: ManagedState): Promise<FontsManagerSnapshot> {
		return this.enqueueManaged(state, async () => this.snapshot(state))
	}

	private setWorkbenchDefaultFamily(
		state: ManagedState,
		family: string | null,
		isAllowed?: (selectedFamily: string) => boolean,
	): Promise<FontsManagerSnapshot> {
		return this.enqueueManaged(state, async () => {
			if (family !== null && typeof family !== 'string') {
				throw new FontsError('INVALID_INPUT', 'Default font family must be text or null')
			}
			const requested = family === null ? undefined : normalizeFamily(family)
			const selected = requested ? findAvailableFamily(requested) : undefined
			if (requested && (!selected || (isAllowed && !isAllowed(selected)))) {
				throw new FontsError('FONT_NOT_FOUND', `Font family "${requested}" is not available`)
			}
			await this.enqueueDefault(async () => {
				this.assertManagedStateActive(state)
				const storage = this.requireDefaultStorage()
				const previous = this.defaults.workbenchFamily
				await persistDefaultFamily(storage, selected)
				try {
					this.assertManagedStateActive(state)
				} catch (error) {
					await persistDefaultFamily(storage, previous).catch((): void => undefined)
					throw error
				}
				this.defaults.workbenchFamily = selected
				if (previous !== selected) nativeRegistryRevision += 1
			})
			return this.snapshot(state)
		})
	}

	private installManagedFont(
		state: ManagedState,
		input: InstallManagedFontInput,
	): Promise<FontsManagerSnapshot> {
		return this.enqueueManaged(state, async () => {
			const borrowed = normalizeManagedInput(input)
			const normalized = Object.freeze({
				...borrowed,
				data: await snapshotBytes(borrowed.data, undefined),
			})
			this.assertFontSize(normalized.data.byteLength)
			const id = await managedFontId(normalized.data, normalized.family)
			this.assertManagedStateActive(state)
			if (state.fonts.has(id)) return this.snapshot(state)
			if (state.fonts.size >= this.config.maxManagedFonts) {
				throw new FontsError(
					'FONT_LIMIT_EXCEEDED',
					`Managed font collection reached its ${this.config.maxManagedFonts} font limit`,
				)
			}
			const installedAt = new Date().toISOString()
			const stored: StoredManagedFont = Object.freeze({
				id,
				fileName: normalized.fileName,
				...(normalized.family ? { family: normalized.family } : {}),
				byteLength: normalized.data.byteLength,
				installedAt,
				data: normalized.data,
			})
			const registration = this.registerBytes(state.owner, stored.data, id, stored.family, false)
			try {
				const encoded = await encodeManagedFont(stored)
				this.assertManagedStateActive(state)
				await state.storage.put(managedFontKey(state.prefix, id), encoded, {
					atomic: true,
				})
				this.assertManagedStateActive(state)
				const snapshot = toManagedFontSnapshot(stored, registration.handle.families)
				state.fonts.set(id, { stored, snapshot, registration })
				return this.snapshot(state)
			} catch (error) {
				this.releaseRegistration(registration)
				if (!state.active) {
					await state.storage.delete(managedFontKey(state.prefix, id)).catch((): void => undefined)
				}
				throw error
			}
		})
	}

	private removeManagedFont(state: ManagedState, id: string): Promise<FontsManagerSnapshot> {
		return this.enqueueManaged(state, async () => {
			if (!MANAGED_ID.test(id)) throw new FontsError('INVALID_INPUT', 'Managed font ID is invalid')
			const font = state.fonts.get(id)
			if (!font) throw new FontsError('FONT_NOT_FOUND', `Managed font ${id} does not exist`)
			await state.storage.delete(managedFontKey(state.prefix, id))
			this.assertManagedStateActive(state)
			state.fonts.delete(id)
			this.releaseRegistration(font.registration)
			return this.snapshot(state)
		})
	}

	private enqueueManaged<T>(state: ManagedState, task: () => Promise<T>): Promise<T> {
		try {
			this.assertManagedStateActive(state)
		} catch (cause) {
			return Promise.reject(cause)
		}
		if (state.pendingTasks >= this.config.maxPendingManagedTasks) {
			return Promise.reject(
				new FontsError(
					'FONT_BUSY',
					`Managed font queue reached its ${this.config.maxPendingManagedTasks} pending task limit`,
				),
			)
		}
		state.pendingTasks += 1
		const result = state.tail.then(async () => {
			this.assertManagedStateActive(state)
			return task()
		})
		const releasePending = (): undefined => {
			state.pendingTasks -= 1
			return undefined
		}
		state.tail = result.then(releasePending, releasePending)
		return result
	}

	private enqueueDefault<T>(task: () => Promise<T>): Promise<T> {
		const result = this.defaults.tail.then(async () => {
			this.assertRunning()
			return task()
		})
		this.defaults.tail = result.then(
			(): void => undefined,
			(): void => undefined,
		)
		return result
	}

	private snapshot(state: ManagedState): FontsManagerSnapshot {
		this.assertManagedStateActive(state)
		return Object.freeze({
			defaultFont: this.resolveDefaultFont(),
			managedFonts: Object.freeze(
				[...state.fonts.values()]
					.map(({ snapshot }) => snapshot)
					.toSorted((left, right) => left.fileName.localeCompare(right.fileName)),
			),
			families: this.resolveFamilies(),
			limits: Object.freeze({
				maxFonts: this.config.maxManagedFonts,
				maxFontBytes: this.config.maxFontBytes,
			}),
		})
	}

	private resolveDefaultFont(): DefaultFontSnapshot {
		const cached = this.defaults.resolvedDefault
		if (cached?.revision === nativeRegistryRevision) return cached.snapshot
		const workbenchFamily = this.defaults.workbenchFamily
		const configuredFamily = this.defaults.configuredFamily
		const selectedWorkbenchFamily = workbenchFamily
			? findAvailableFamily(workbenchFamily)
			: undefined
		const selectedConfiguredFamily = configuredFamily
			? findAvailableFamily(configuredFamily)
			: undefined
		const automaticFamily =
			selectedWorkbenchFamily || selectedConfiguredFamily
				? undefined
				: findAutomaticSystemFamily(this.defaults.systemFamilies)
		const resolved = selectedWorkbenchFamily
			? { family: selectedWorkbenchFamily, source: 'workbench' as const }
			: selectedConfiguredFamily
				? { family: selectedConfiguredFamily, source: 'config' as const }
				: automaticFamily
					? { family: automaticFamily, source: 'system' as const }
					: { family: 'sans-serif', source: 'generic' as const }
		const snapshot = Object.freeze({
			...resolved,
			cssFamily: toCssFamily(resolved.family),
			...(workbenchFamily ? { workbenchFamily } : {}),
			...(configuredFamily ? { configuredFamily } : {}),
		})
		this.defaults.resolvedDefault = Object.freeze({
			revision: nativeRegistryRevision,
			snapshot,
		})
		return snapshot
	}

	private resolveFamilies(): readonly FontFamilySnapshot[] {
		const cached = this.defaults.resolvedFamilies
		if (cached?.revision === nativeRegistryRevision) return cached.snapshot
		const snapshot = fontFamiliesSnapshot(this.defaults.systemFamilies)
		this.defaults.resolvedFamilies = Object.freeze({
			revision: nativeRegistryRevision,
			snapshot,
		})
		return snapshot
	}

	private registerBytes(
		owner: Context,
		data: Uint8Array,
		id: string,
		family?: string,
		enforceOwnerLimit = true,
	): OwnedRegistration {
		if (enforceOwnerLimit) this.assertOwnerCapacity(owner)
		this.assertNativeCapacity(data.byteLength)
		const source = Object.freeze({ id, ...(family ? { family } : {}), data })
		const before = familySignatures()
		let key: FontKey | null
		try {
			key = GlobalFonts.register(bufferView(data), family)
		} catch (cause) {
			throw new FontsError('INVALID_FONT', 'Native font registration rejected the font data', {
				cause,
			})
		}
		if (!key)
			throw new FontsError('INVALID_FONT', 'Native font registration rejected the font data')
		let families: readonly string[]
		try {
			families = changedFamilies(before)
		} catch (cause) {
			GlobalFonts.remove(key)
			throw new FontsError('INVALID_FONT', 'Native font registration could not be inspected', {
				cause,
			})
		}
		return this.ownNativeRegistration(owner, key, families, source)
	}

	private ownNativeRegistration(
		owner: Context,
		key: FontKey,
		families: readonly string[],
		source: PortableFontSource,
	): OwnedRegistration {
		const registrations = this.registrations
		const registrationsByOwner = this.registrationsByOwner
		const portableFonts = this.portableFontsState
		const nativeBudget = this.nativeBudget
		let registration!: OwnedRegistration
		const release = () =>
			releaseOwnedRegistration(
				registrations,
				registrationsByOwner,
				portableFonts,
				nativeBudget,
				registration,
			)
		const handle = new FontRegistrationHandle(families, release)
		registration = Object.freeze({
			key,
			owner,
			handle,
			portableId: source.id,
			byteLength: source.data.byteLength,
		})
		registrations.add(registration)
		attachPortableFont(portableFonts, source, families)
		nativeBudget.bytes += source.data.byteLength
		let ownerRegistrations = registrationsByOwner.get(owner)
		if (!ownerRegistrations) {
			ownerRegistrations = new Set()
			registrationsByOwner.set(owner, ownerRegistrations)
		}
		ownerRegistrations.add(registration)
		try {
			owner.effects.defer(release, {
				tag: 'font-registration',
			})
		} catch (cause) {
			release()
			throw new FontsError('NOT_RUNNING', 'Font owner is stopped or being replaced', { cause })
		}
		nativeRegistryRevision += 1
		return registration
	}

	private releaseRegistration(registration: OwnedRegistration): void {
		releaseOwnedRegistration(
			this.registrations,
			this.registrationsByOwner,
			this.portableFontsState,
			this.nativeBudget,
			registration,
		)
	}

	private assertOwnerCapacity(owner: Context): void {
		const count = this.registrationsByOwner.get(owner)?.size ?? 0
		if (count >= this.config.maxRegistrationsPerConsumer) {
			throw new FontsError(
				'FONT_LIMIT_EXCEEDED',
				`Font owner reached its ${this.config.maxRegistrationsPerConsumer} registration limit`,
			)
		}
	}

	private assertNativeCapacity(byteLength: number): void {
		if (this.registrations.size >= this.config.maxNativeRegistrations) {
			throw new FontsError(
				'FONT_LIMIT_EXCEEDED',
				`FontsPlugin reached its ${this.config.maxNativeRegistrations} native registration limit`,
			)
		}
		if (byteLength > this.config.maxTotalFontBytes - this.nativeBudget.bytes) {
			throw new FontsError(
				'FONT_LIMIT_EXCEEDED',
				`Native registrations would exceed the configured ${this.config.maxTotalFontBytes} byte limit`,
			)
		}
	}

	private requireOwnerLease(): FontsOwnerLease {
		const generation = this.generation
		if (!generation) throw new FontsError('NOT_RUNNING', 'FontsPlugin is not running')
		const owner = this.ctx.caller ?? this.ctx
		const existing = this.ownerLeases.get(owner)
		if (existing) {
			this.assertOwnerLease(existing)
			if (existing.generation !== generation) {
				throw new FontsError('NOT_RUNNING', 'Font owner belongs to a stopped plugin generation')
			}
			return existing
		}
		const lease: FontsOwnerLease = Object.freeze({
			owner,
			generation,
			controller: new AbortController(),
			schedulerOwner: generation.scheduler.createOwner(),
			state: { active: true },
		})
		this.leases.add(lease)
		this.ownerLeases.set(owner, lease)
		try {
			owner.effects.defer(() => this.closeOwnerLease(lease), { tag: 'fonts-caller' })
		} catch (cause) {
			this.closeOwnerLease(lease)
			throw new FontsError('NOT_RUNNING', 'Font owner is stopped or being replaced', { cause })
		}
		return lease
	}

	private assertOwnerLease(lease: FontsOwnerLease): void {
		if (
			!lease.state.active ||
			this.ownerLeases.get(lease.owner) !== lease ||
			this.generation !== lease.generation
		) {
			throw new FontsError('NOT_RUNNING', 'Font owner is stopped or being replaced')
		}
	}

	private closeOwnerLease(lease: FontsOwnerLease, reason?: Error): void {
		if (!lease.state.active) return
		lease.state.active = false
		const stopped =
			reason ?? new FontsError('NOT_RUNNING', 'Font owner is stopped or being replaced')
		lease.controller.abort(stopped)
		lease.generation.scheduler.closeOwner(lease.schedulerOwner, stopped)
		this.leases.delete(lease)
		if (this.ownerLeases.get(lease.owner) === lease) this.ownerLeases.delete(lease.owner)
	}

	private async runFontTask<T>(
		lease: FontsOwnerLease,
		callerSignal: AbortSignal | undefined,
		task: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const abortLink = linkAbortSignals([lease.controller.signal, callerSignal])
		try {
			return await lease.generation.scheduler.run(
				lease.schedulerOwner,
				abortLink.signal,
				async () => task(abortLink.signal),
			)
		} finally {
			abortLink.dispose()
		}
	}

	private assertFontSize(byteLength: number): void {
		if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
			throw new FontsError('INVALID_INPUT', 'Font data must not be empty')
		}
		if (byteLength > this.config.maxFontBytes) {
			throw new FontsError(
				'FONT_TOO_LARGE',
				`Font is ${byteLength} bytes; the configured limit is ${this.config.maxFontBytes}`,
			)
		}
	}

	private assertManagedStateActive(state: ManagedState): void {
		this.assertRunning()
		if (!state.active || (this.managed !== undefined && this.managed !== state)) {
			throw new FontsError('NOT_RUNNING', 'Managed fonts belong to a stopped plugin generation')
		}
	}

	private requireDefaultStorage(): PersistenceNamespace {
		if (!this.defaults.storage) {
			throw new FontsError('NOT_RUNNING', 'FontsPlugin default font storage is not available')
		}
		return this.defaults.storage
	}

	private assertRunning(): void {
		if (!this.running) throw new FontsError('NOT_RUNNING', 'FontsPlugin is not running')
	}

	private requireLifecycleRevision(): number {
		this.assertRunning()
		return this.lifecycleRevision
	}

	private assertLifecycleRevision(revision: number): void {
		if (!this.running || revision !== this.lifecycleRevision) {
			throw new FontsError('NOT_RUNNING', 'Fonts capability belongs to a stopped plugin generation')
		}
	}
}

class FontRegistrationHandle implements FontRegistration {
	active = true
	readonly families: readonly string[]

	constructor(
		families: readonly string[],
		private readonly release: () => void,
	) {
		this.families = Object.freeze([...families])
	}

	dispose(): void {
		this.release()
	}

	deactivate(): void {
		this.active = false
	}
}

class FontsManagerRpc extends RpcTarget implements FontsWorkbenchCommands {
	constructor(
		private readonly read: () => Promise<FontsManagerSnapshot>,
		private readonly selectDefault: (family: string | null) => Promise<FontsManagerSnapshot>,
		private readonly add: (input: InstallManagedFontInput) => Promise<FontsManagerSnapshot>,
		private readonly drop: (id: string) => Promise<FontsManagerSnapshot>,
	) {
		super()
	}

	snapshot(): Promise<FontsManagerSnapshot> {
		return this.read()
	}

	setDefaultFamily(family: string | null): Promise<FontsManagerSnapshot> {
		return this.selectDefault(family)
	}

	install(input: InstallManagedFontInput): Promise<FontsManagerSnapshot> {
		return this.add(input)
	}

	remove(id: string): Promise<FontsManagerSnapshot> {
		return this.drop(id)
	}
}

class FontSelectionRpc extends RpcTarget implements FontSelectionCommands {
	constructor(
		private readonly read: () => Promise<FontSelectionSnapshot>,
		private readonly selectDefault: (family: string | null) => Promise<FontSelectionSnapshot>,
	) {
		super()
	}

	snapshot(): Promise<FontSelectionSnapshot> {
		return this.read()
	}

	setDefaultFamily(family: string | null): Promise<FontSelectionSnapshot> {
		return this.selectDefault(family)
	}
}

function toSelectionSnapshot(
	snapshot: FontsManagerSnapshot,
	allowedFamilies?: ReadonlySet<string>,
): FontSelectionSnapshot {
	return Object.freeze({
		defaultFont: snapshot.defaultFont,
		families:
			allowedFamilies === undefined
				? snapshot.families
				: Object.freeze(
						snapshot.families.filter((font) =>
							allowedFamilies.has(font.family.toLocaleLowerCase('en-US')),
						),
					),
	})
}

function portableFamilyKeys(state: PortableFontsState): ReadonlySet<string> {
	const families = new Set<string>()
	for (const { source, resolvedFamilies } of state.entries.values()) {
		if (source.family) {
			families.add(source.family.toLocaleLowerCase('en-US'))
			continue
		}
		for (const family of resolvedFamilies) families.add(family.toLocaleLowerCase('en-US'))
	}
	return families
}

function normalizeManagedInput(
	input: InstallManagedFontInput,
): Readonly<{ fileName: string; family?: string; data: Uint8Array }> {
	if (!input || typeof input !== 'object' || !(input.data instanceof Uint8Array)) {
		throw new FontsError('INVALID_INPUT', 'Managed font data must be a Uint8Array')
	}
	const rawFileName = typeof input.fileName === 'string' ? input.fileName.trim() : ''
	const fileName = rawFileName.split(/[\\/]/).at(-1)?.trim() ?? ''
	if (!fileName || fileName.length > MAX_FILE_NAME_LENGTH || hasControlCharacters(fileName)) {
		throw new FontsError('INVALID_INPUT', 'Managed font fileName is invalid')
	}
	const family = normalizeFamily(input.family)
	return Object.freeze({
		fileName,
		...(family ? { family } : {}),
		data: input.data,
	})
}

function normalizeFamily(value: unknown): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string') throw new FontsError('INVALID_INPUT', 'Font family must be text')
	const family = value.trim()
	if (!family || family.length > MAX_FAMILY_LENGTH || hasControlCharacters(family)) {
		throw new FontsError('INVALID_INPUT', 'Font family alias is invalid')
	}
	return family
}

function normalizeSignal(value: unknown): AbortSignal | undefined {
	if (value === undefined) return undefined
	if (
		!value ||
		typeof value !== 'object' ||
		typeof (value as AbortSignal).aborted !== 'boolean' ||
		typeof (value as AbortSignal).addEventListener !== 'function' ||
		typeof (value as AbortSignal).removeEventListener !== 'function'
	) {
		throw new FontsError('INVALID_INPUT', 'signal must be an AbortSignal')
	}
	return value as AbortSignal
}

function linkAbortSignals(signals: readonly (AbortSignal | undefined)[]): Readonly<{
	signal: AbortSignal
	dispose(): void
}> {
	const controller = new AbortController()
	const listeners: Array<Readonly<{ signal: AbortSignal; listener: () => void }>> = []
	for (const signal of signals) {
		if (!signal) continue
		if (signal.aborted) {
			controller.abort(signal.reason)
			break
		}
		const listener = () => controller.abort(signal.reason)
		signal.addEventListener('abort', listener, { once: true })
		listeners.push({ signal, listener })
	}
	return Object.freeze({
		signal: controller.signal,
		dispose(): void {
			for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener)
		},
	})
}

async function readBoundedFontFile(
	path: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<Buffer> {
	signal.throwIfAborted()
	const handle = await open(path, 'r')
	try {
		const file = await handle.stat()
		if (!file.isFile()) throw new TypeError('Path is not a file')
		if (!Number.isSafeInteger(file.size) || file.size <= 0) {
			throw new FontsError('INVALID_INPUT', 'Font file must not be empty')
		}
		if (file.size > maxBytes) {
			throw new FontsError(
				'FONT_TOO_LARGE',
				`Font is ${file.size} bytes; the configured limit is ${maxBytes}`,
			)
		}
		const data = Buffer.allocUnsafe(file.size)
		const chunkBytes = 1024 * 1024
		let offset = 0
		while (offset < data.byteLength) {
			signal.throwIfAborted()
			const { bytesRead } = await handle.read(
				data,
				offset,
				Math.min(chunkBytes, data.byteLength - offset),
				offset,
			)
			if (bytesRead === 0) throw new Error('Font file changed while it was being read')
			offset += bytesRead
		}
		signal.throwIfAborted()
		const probe = Buffer.allocUnsafe(1)
		const probeResult = await handle.read(probe, 0, 1, data.byteLength)
		if (probeResult.bytesRead !== 0) {
			throw new Error('Font file changed while it was being read')
		}
		return data
	} finally {
		await handle.close()
	}
}

async function snapshotBytes(
	data: Uint8Array,
	signal: AbortSignal | undefined,
): Promise<Uint8Array> {
	if (signal?.aborted) throw abortReason(signal, 'Font byte snapshot aborted')
	const snapshot = new Uint8Array(data.byteLength)
	const chunkBytes = 1024 * 1024
	for (let offset = 0; offset < data.byteLength; offset += chunkBytes) {
		if (offset > 0) await new Promise<void>((resolve) => setImmediate(resolve))
		if (signal?.aborted) throw abortReason(signal, 'Font byte snapshot aborted')
		snapshot.set(data.subarray(offset, Math.min(offset + chunkBytes, data.byteLength)), offset)
	}
	return snapshot
}

function abortReason(signal: AbortSignal, fallback: string): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException(fallback, 'AbortError')
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

function bufferView(data: Uint8Array): Buffer {
	if (Buffer.isBuffer(data)) return data
	return data.buffer instanceof ArrayBuffer
		? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
		: Buffer.from(data)
}

function fontFamiliesSnapshot(systemFamilies: ReadonlySet<string>): readonly FontFamilySnapshot[] {
	return Object.freeze(
		GlobalFonts.families
			.map((item) =>
				Object.freeze({
					family: item.family,
					source: systemFamilies.has(item.family) ? ('system' as const) : ('registered' as const),
					styles: Object.freeze(item.styles.map((style) => Object.freeze({ ...style }))),
				}),
			)
			.toSorted((left, right) => left.family.localeCompare(right.family)),
	)
}

async function loadDefaultFamily(storage: PersistenceNamespace): Promise<string | undefined> {
	const value = await storage.getText(DEFAULT_FONT_KEY)
	if (value === undefined) return undefined
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new TypeError('Default font record must be an object')
		}
		const record = parsed as Record<string, unknown>
		if (record.version !== 1) throw new Error('Default font record has an unsupported version')
		if (typeof record.family !== 'string') {
			throw new TypeError('Default font record family must be text')
		}
		return normalizeFamily(record.family)
	} catch (cause) {
		if (cause instanceof FontsError && cause.code === 'CORRUPT_FONT_STORAGE') throw cause
		throw new FontsError('CORRUPT_FONT_STORAGE', 'Default font preference is corrupt', {
			cause,
		})
	}
}

async function persistDefaultFamily(
	storage: PersistenceNamespace,
	family: string | undefined,
): Promise<void> {
	if (!family) {
		await storage.delete(DEFAULT_FONT_KEY)
		return
	}
	await storage.put(DEFAULT_FONT_KEY, `${JSON.stringify({ version: 1, family })}\n`, {
		atomic: true,
	})
}

function findAvailableFamily(requested: string): string | undefined {
	const generic = requested.toLowerCase()
	if (GENERIC_FAMILIES.has(generic)) return generic
	const requestedKey = requested.toLocaleLowerCase('en-US')
	return GlobalFonts.families.find(
		({ family }) => family.toLocaleLowerCase('en-US') === requestedKey,
	)?.family
}

function findAutomaticSystemFamily(systemFamilies: ReadonlySet<string>): string | undefined {
	const visible = new Map(
		GlobalFonts.families.map(({ family }) => [family.toLocaleLowerCase('en-US'), family]),
	)
	const available = [...systemFamilies].flatMap((family) => {
		const current = visible.get(family.toLocaleLowerCase('en-US'))
		return current === undefined ? [] : [current]
	})
	const availableByKey = new Map(
		available.map((family) => [family.toLocaleLowerCase('en-US'), family]),
	)
	const preferences =
		process.platform === 'darwin'
			? ['SF Pro Text', 'SF Pro Display', 'PingFang HK', 'PingFang SC', 'Helvetica Neue', 'Arial']
			: process.platform === 'win32'
				? ['Segoe UI', 'Microsoft JhengHei UI', 'Microsoft YaHei UI', 'Arial']
				: [
						'Noto Sans',
						'Noto Sans CJK HK',
						'Noto Sans CJK SC',
						'DejaVu Sans',
						'Liberation Sans',
						'Ubuntu',
					]
	for (const preferred of preferences) {
		const matched = availableByKey.get(preferred.toLocaleLowerCase('en-US'))
		if (matched) return matched
	}
	return available.toSorted((left, right) => left.localeCompare(right))[0]
}

function toCssFamily(family: string): string {
	if (GENERIC_FAMILIES.has(family)) return family
	return `"${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function familySignatures(): Map<string, string> {
	return new Map(
		GlobalFonts.families.map(({ family, styles }) => [
			family,
			JSON.stringify(styles.map(({ weight, width, style }) => ({ weight, width, style }))),
		]),
	)
}

function changedFamilies(before: ReadonlyMap<string, string>): readonly string[] {
	return Object.freeze(
		GlobalFonts.families
			.filter(({ family, styles }) => {
				const signature = JSON.stringify(
					styles.map(({ weight, width, style }) => ({ weight, width, style })),
				)
				return before.get(family) !== signature
			})
			.map(({ family }) => family)
			.toSorted(),
	)
}

export { FontsConfig, FontsError, type FontsErrorCode, type FontsPluginConfig }
export type {
	DefaultFontSnapshot,
	FontFamilySnapshot,
	FontStyleSnapshot,
} from './workbench-contract.ts'
