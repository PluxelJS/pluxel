import type { PersistenceNamespace } from '@pluxel/runtime'
import type { EntryResolutionOk } from '../scan/types'
import type { PackageSpecifierSnapshot } from './specifiers'
import type {
	PackageInstallStatus,
	PackageLoadIssueSource,
	PluginPackageDependencies,
} from './types'

export const CURRENT_STATE_SCHEMA = 4

export interface PersistedInstallMeta {
	status: PackageInstallStatus
	at: number
}

export interface PersistedPackageEntry {
	spec: PackageSpecifierSnapshot
	resolution: EntryResolutionOk
	moduleId: string
	isAnchor: boolean
	loadedAt: number
	pluginPackages: PluginPackageDependencies
	manifestPath?: string
	manifestVersion?: string
	resolvedVersion?: string
	install?: PersistedInstallMeta
}

export interface PersistedLoadIssue {
	spec: PackageSpecifierSnapshot
	source: PackageLoadIssueSource
	message: string
	moduleId?: string
	recordedAt: number
	stack?: string | undefined
}

export interface PackageStatePayload {
	schema: number
	generatedAt: string
	packages: PersistedPackageEntry[]
	issues: PersistedLoadIssue[]
	blocked?: string[] | undefined
}

export interface PackageStateStoreOptions {
	/**
	 * Runtime-owned persistence namespace used by the store.
	 */
	storage: PersistenceNamespace
	file: string
	enabled?: boolean
	debounceMs?: number | undefined
	onError?: ((error: unknown) => void) | undefined
}

/**
 * Lightweight debounced writer for package state.
 * - Does not attempt to validate the payload; the caller owns shape conversion.
 * - Writes atomically through runtime persistence to avoid partial state.
 */
export class PackageStateStore {
	private timer: ReturnType<typeof setTimeout> | undefined
	private latest: PackageStatePayload | undefined
	private readonly storage: PersistenceNamespace
	private readonly file: string
	private readonly enabled: boolean
	private readonly debounceMs: number
	private readonly onError: ((error: unknown) => void) | undefined

	constructor(options: PackageStateStoreOptions) {
		this.storage = options.storage
		this.file = options.file
		this.enabled = options.enabled !== false
		this.debounceMs = Math.max(0, options.debounceMs ?? 120)
		this.onError = options.onError
	}

	async read(): Promise<PackageStatePayload | null> {
		if (!this.enabled) return null
		const raw = await this.storage.getText(this.file)
		if (raw === undefined) return null
		const parsed = parsePackageStatePayload(raw, this.file)
		if (!parsed) return null
		return parsed
	}

	scheduleWrite(snapshot: PackageStatePayload) {
		if (!this.enabled) return
		this.latest = snapshot
		if (this.timer) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			this.flush().catch((error) => {
				this.onError?.(error)
			})
		}, this.debounceMs)
	}

	async flush(): Promise<void> {
		if (!this.enabled) return
		if (!this.latest) return
		const snapshot = this.latest
		this.latest = undefined
		try {
			await writeJsonAtomic(this.storage, this.file, snapshot)
		} catch (error) {
			this.onError?.(error)
			throw error
		}
	}
}

async function writeJsonAtomic(
	storage: PersistenceNamespace,
	file: string,
	payload: PackageStatePayload,
) {
	const content = JSON.stringify(payload, null, 2)
	await storage.put(file, content)
}

function isRecord(input: unknown): input is Record<string, unknown> {
	return Boolean(input) && typeof input === 'object' && !Array.isArray(input)
}

function parsePackageStatePayload(raw: string, file: string): PackageStatePayload | null {
	const parsed = JSON.parse(raw) as unknown
	if (!isRecord(parsed)) {
		throw new Error(`[package-state] Invalid state payload (not an object): ${file}`)
	}
	const schema = (parsed as any).schema
	if (typeof schema !== 'number' || !Number.isFinite(schema)) {
		throw new TypeError(`[package-state] Invalid state payload (missing schema): ${file}`)
	}
	if (schema !== CURRENT_STATE_SCHEMA) {
		// We intentionally do not provide legacy migrations here.
		// Treat it as a cache miss so HMR hosts can continue booting after refactors.
		return null
	}
	if (!Array.isArray((parsed as any).packages) || !Array.isArray((parsed as any).issues)) {
		throw new TypeError(`[package-state] Invalid state payload (missing arrays): ${file}`)
	}
	return parsed as unknown as PackageStatePayload
}
