import type { EntryResolutionOk } from '../scan/ScanService'
import type { PackageSpecifierSnapshot } from './specifiers'
import type { PackageInstallStatus, PackageLoadIssueSource } from './types'

export const CURRENT_STATE_SCHEMA = 3

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
	dependOn: string[]
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

export interface LegacyPersistedPackageEntry {
	spec: PackageSpecifierSnapshot
	resolution: EntryResolutionOk
	moduleId: string
	isAnchor: boolean
	installStatus?: PackageInstallStatus | undefined
	loadedAt: number
}

export interface LegacyPackageStatePayload {
	generatedAt: string
	packages: LegacyPersistedPackageEntry[]
	schema?: number
}

export interface PackageStateStoreOptions {
	/**
	 * Minimal text file I/O used by the store.
	 * Usually `ctx.fs`.
	 */
	fs: TextFs
	file: string
	debounceMs?: number | undefined
	onError?: ((error: unknown) => void) | undefined
}

export interface TextFs {
	readText(path: string): Promise<string>
	writeTextAtomic(path: string, data: string): Promise<void>
}

/**
 * Lightweight debounced writer for package state.
 * - Does not attempt to validate the payload; the caller owns shape conversion.
 * - Writes atomically via the provided fs implementation to avoid partial state.
 */
export class PackageStateStore {
	private timer: NodeJS.Timeout | undefined
	private latest: PackageStatePayload | undefined
	private readonly fs: TextFs
	private readonly file: string
	private readonly debounceMs: number
	private readonly onError: ((error: unknown) => void) | undefined

	constructor(options: PackageStateStoreOptions) {
		this.fs = options.fs
		this.file = options.file
		this.debounceMs = Math.max(0, options.debounceMs ?? 120)
		this.onError = options.onError
	}

	async read(): Promise<PackageStatePayload | LegacyPackageStatePayload | null> {
		try {
			const raw = await this.fs.readText(this.file)
			return JSON.parse(raw) as PackageStatePayload | LegacyPackageStatePayload
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return null
			}
			throw error
		}
	}

	scheduleWrite(snapshot: PackageStatePayload) {
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
		if (!this.latest) return
		const snapshot = this.latest
		this.latest = undefined
		try {
			await writeJsonAtomic(this.fs, this.file, snapshot)
		} catch (error) {
			this.onError?.(error)
			throw error
		}
	}
}

async function writeJsonAtomic(fs: TextFs, file: string, payload: PackageStatePayload) {
	const content = JSON.stringify(payload, null, 2)
	await fs.writeTextAtomic(file, content)
}
