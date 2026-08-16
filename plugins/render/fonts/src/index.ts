import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { GlobalFonts, type FontKey } from '@napi-rs/canvas'
import { BasePlugin, Plugin, type Context, type PersistenceNamespace } from '@pluxel/runtime'
import { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import { FontsConfig, type FontsPluginConfig } from './config.ts'
import {
	decodeManagedFont,
	encodeManagedFont,
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
	data: Uint8Array
	/** Optional family alias used by CSS canvas font strings. */
	family?: string
}>

export type FontPathRegistrationInput = Readonly<{
	/** Absolute server path. The file is read synchronously by the native font registry. */
	path: string
	/** Optional family alias used by CSS canvas font strings. */
	family?: string
}>

export interface FontRegistration {
	/** Family names added or changed by this registration. */
	readonly families: readonly string[]
	readonly active: boolean
	/** Removes this registration. Repeated calls are harmless. */
	dispose(): void
}

export type FontsErrorCode =
	| 'NOT_RUNNING'
	| 'INVALID_INPUT'
	| 'INVALID_FONT'
	| 'FONT_TOO_LARGE'
	| 'FONT_LIMIT_EXCEEDED'
	| 'FONT_NOT_FOUND'
	| 'CORRUPT_FONT_STORAGE'

export class FontsError extends Error {
	override readonly name = 'FontsError'

	constructor(
		readonly code: FontsErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

type OwnedRegistration = Readonly<{
	key: FontKey
	owner: Context
	handle: FontRegistrationHandle
}>

type ManagedRuntimeFont = Readonly<{
	stored: StoredManagedFont
	snapshot: ManagedFontSnapshot
	registration: OwnedRegistration
}>

type ManagedState = {
	readonly owner: Context
	readonly storage: PersistenceNamespace
	readonly prefix: string
	readonly fonts: Map<string, ManagedRuntimeFont>
	active: boolean
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
	private readonly defaults: DefaultFontState = {
		systemFamilies: new Set(),
		tail: Promise.resolve(),
	}
	private managed?: ManagedState
	private running = false

	override async init(): Promise<void> {
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
		this.running = true
		this.ctx.effects.defer(
			() => {
				this.running = false
				this.defaults.configuredFamily = undefined
				this.defaults.workbenchFamily = undefined
				this.defaults.storage = undefined
				this.defaults.resolvedDefault = undefined
				this.defaults.resolvedFamilies = undefined
				this.defaults.systemFamilies.clear()
				if (this.managed) {
					this.managed.active = false
					this.managed.fonts.clear()
					this.managed = undefined
				}
				const active = [...this.registrations]
				this.registrations.clear()
				for (const registration of active) {
					this.registrationsByOwner.get(registration.owner)?.delete(registration)
					registration.handle.deactivate()
				}
				if (active.length > 0) {
					GlobalFonts.removeBatch(active.map(({ key }) => key))
					nativeRegistryRevision += 1
				}
			},
			{ tag: 'fonts-registry' },
		)
		this.managed = await this.initializeManagedFonts(storage)
		this.ctx.workbench.mount(FontsWorkbench, {
			fonts: workbench.bind.rpc(() => this.createWorkbenchManager()),
		})
	}

	/** Registers font bytes for the current caller generation. */
	register(input: FontRegistrationInput): FontRegistration {
		this.assertRunning()
		if (!input || !(input.data instanceof Uint8Array)) {
			throw new FontsError('INVALID_INPUT', 'Font data must be a Uint8Array')
		}
		const family = normalizeFamily(input.family)
		this.assertFontSize(input.data.byteLength)
		const owner = this.ctx.caller ?? this.ctx
		return this.registerBytes(owner, input.data, family).handle
	}

	/** Registers one font from an absolute server path for the current caller generation. */
	registerFromPath(input: FontPathRegistrationInput): FontRegistration {
		this.assertRunning()
		if (!input || typeof input.path !== 'string' || !isAbsolute(input.path)) {
			throw new FontsError('INVALID_INPUT', 'Font path must be an absolute server path')
		}
		const family = normalizeFamily(input.family)
		let size: number
		try {
			const stat = statSync(input.path)
			if (!stat.isFile()) throw new Error('Path is not a file')
			size = stat.size
		} catch (cause) {
			throw new FontsError('INVALID_INPUT', `Cannot read font file at ${input.path}`, { cause })
		}
		this.assertFontSize(size)
		const owner = this.ctx.caller ?? this.ctx
		this.assertOwnerCapacity(owner)
		const before = familySignatures()
		let key: FontKey | null
		try {
			key = GlobalFonts.registerFromPath(input.path, family)
		} catch (cause) {
			throw new FontsError('INVALID_FONT', `Native font registration failed for ${input.path}`, {
				cause,
			})
		}
		if (!key)
			throw new FontsError('INVALID_FONT', `Native font registration failed for ${input.path}`)
		return this.ownNativeRegistration(owner, key, changedFamilies(before)).handle
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
	selectionManager(): RpcTarget & FontSelectionCommands {
		this.assertRunning()
		const state = this.managed
		if (!state?.active) {
			throw new FontsError('NOT_RUNNING', 'Managed font collection is not available')
		}
		return new FontSelectionRpc(
			async () => toSelectionSnapshot(await this.readManagedSnapshot(state)),
			async (family) => toSelectionSnapshot(await this.setWorkbenchDefaultFamily(state, family)),
		)
	}

	private async initializeManagedFonts(storage: PersistenceNamespace): Promise<ManagedState> {
		const state: ManagedState = {
			owner: this.ctx,
			storage,
			prefix: 'managed',
			fonts: new Map(),
			active: true,
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
				let stored: StoredManagedFont
				try {
					stored = decodeManagedFont(value, id)
				} catch (cause) {
					throw new FontsError('CORRUPT_FONT_STORAGE', `Managed font is corrupt: ${entry.key}`, {
						cause,
					})
				}
				this.assertFontSize(stored.byteLength)
				this.assertManagedStateActive(state)
				const registration = this.registerBytes(state.owner, stored.data, stored.family, false)
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
	): Promise<FontsManagerSnapshot> {
		return this.enqueueManaged(state, async () => {
			if (family !== null && typeof family !== 'string') {
				throw new FontsError('INVALID_INPUT', 'Default font family must be text or null')
			}
			const requested = family === null ? undefined : normalizeFamily(family)
			const selected = requested ? findAvailableFamily(requested) : undefined
			if (requested && !selected) {
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
			const normalized = normalizeManagedInput(input)
			this.assertFontSize(normalized.data.byteLength)
			const id = managedFontId(normalized.data, normalized.family)
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
			const registration = this.registerBytes(state.owner, stored.data, stored.family, false)
			try {
				await state.storage.put(managedFontKey(state.prefix, id), encodeManagedFont(stored), {
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
		const result = state.tail.then(async () => {
			this.assertManagedStateActive(state)
			return task()
		})
		state.tail = result.then(
			(): void => undefined,
			(): void => undefined,
		)
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
		family?: string,
		enforceOwnerLimit = true,
	): OwnedRegistration {
		if (enforceOwnerLimit) this.assertOwnerCapacity(owner)
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
		return this.ownNativeRegistration(owner, key, changedFamilies(before))
	}

	private ownNativeRegistration(
		owner: Context,
		key: FontKey,
		families: readonly string[],
	): OwnedRegistration {
		let registration!: OwnedRegistration
		const handle = new FontRegistrationHandle(families, () =>
			this.releaseRegistration(registration),
		)
		registration = Object.freeze({ key, owner, handle })
		this.registrations.add(registration)
		let ownerRegistrations = this.registrationsByOwner.get(owner)
		if (!ownerRegistrations) {
			ownerRegistrations = new Set()
			this.registrationsByOwner.set(owner, ownerRegistrations)
		}
		ownerRegistrations.add(registration)
		try {
			owner.effects.defer(() => this.releaseRegistration(registration), {
				tag: 'font-registration',
			})
		} catch (cause) {
			this.releaseRegistration(registration)
			throw new FontsError('NOT_RUNNING', 'Font owner is stopped or being replaced', { cause })
		}
		nativeRegistryRevision += 1
		return registration
	}

	private releaseRegistration(registration: OwnedRegistration): void {
		if (!registration.handle.active) return
		registration.handle.deactivate()
		this.registrations.delete(registration)
		this.registrationsByOwner.get(registration.owner)?.delete(registration)
		GlobalFonts.remove(registration.key)
		nativeRegistryRevision += 1
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

function toSelectionSnapshot(snapshot: FontsManagerSnapshot): FontSelectionSnapshot {
	return Object.freeze({
		defaultFont: snapshot.defaultFont,
		families: snapshot.families,
	})
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
		data: Uint8Array.from(input.data),
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

export { FontsConfig, type FontsPluginConfig }
export type {
	DefaultFontSnapshot,
	FontFamilySnapshot,
	FontStyleSnapshot,
} from './workbench-contract.ts'
