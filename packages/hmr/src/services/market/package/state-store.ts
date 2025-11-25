import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'pathe'

import type { PackageInstallStatus, PackageLoadIssueSource } from '../PackageService'
import type { EntryResolutionOk } from '../ScanService'
import type { PackageSpecifierSnapshot } from '../specifiers'

export const CURRENT_STATE_SCHEMA = 2

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
}

export interface PackageStatePayload {
	schema: number
	generatedAt: string
	packages: PersistedPackageEntry[]
	issues: PersistedLoadIssue[]
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
	file: string
	debounceMs?: number | undefined
	onError?: ((error: unknown) => void) | undefined
}

/**
 * Lightweight debounced writer for package state.
 * - Does not attempt to validate the payload; the caller owns shape conversion.
 * - Writes atomically via a temp file to avoid partial state.
 */
export class PackageStateStore {
	private timer: NodeJS.Timeout | undefined
	private latest: PackageStatePayload | undefined
	private readonly file: string
	private readonly debounceMs: number
	private readonly onError: ((error: unknown) => void) | undefined

	constructor(options: PackageStateStoreOptions) {
		this.file = options.file
		this.debounceMs = Math.max(0, options.debounceMs ?? 120)
		this.onError = options.onError
	}

	async read(): Promise<PackageStatePayload | LegacyPackageStatePayload | null> {
		try {
			const raw = await readFile(this.file, 'utf-8')
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
			await writeJsonAtomic(this.file, snapshot)
		} catch (error) {
			this.onError?.(error)
			throw error
		}
	}
}

async function writeJsonAtomic(file: string, payload: PackageStatePayload) {
	const dir = dirname(file)
	const base = basename(file)
	const tmp = join(dir, `.${base}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)

	await mkdir(dir, { recursive: true })
	const content = JSON.stringify(payload, null, 2)
	try {
		await writeFile(tmp, content, 'utf-8')
		await rename(tmp, file)
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'EXDEV') {
			await copyFile(tmp, file)
			await rm(tmp, { force: true }).catch(() => {})
			return
		}
		await rm(tmp, { force: true }).catch(() => {})
		throw error
	}
}
