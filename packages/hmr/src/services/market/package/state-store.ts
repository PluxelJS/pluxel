import { basename, dirname, join } from 'pathe'
import {
	copyFile,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises'
import type { PackageInstallStatus } from '../PackageService'
import type { EntryResolutionOk } from '../ScanService'
import type { NormalizedPackageSpecifier } from '../specifiers'

export interface PersistedPackageEntry {
	spec: NormalizedPackageSpecifier
	resolution: EntryResolutionOk
	moduleId: string
	isAnchor: boolean
	installStatus?: PackageInstallStatus
	loadedAt: number
}

export interface PackageStatePayload {
	generatedAt: string
	packages: PersistedPackageEntry[]
}

export interface PackageStateStoreOptions {
	file: string
	debounceMs?: number
	onError?: (error: unknown) => void
}

export class PackageStateStore {
	private timer?: NodeJS.Timeout
	private latest?: PackageStatePayload
	private readonly file: string
	private readonly debounceMs: number
	private readonly onError?: (error: unknown) => void

	constructor(options: PackageStateStoreOptions) {
		this.file = options.file
		this.debounceMs = Math.max(0, options.debounceMs ?? 120)
		this.onError = options.onError
	}

	async read(): Promise<PackageStatePayload | null> {
		try {
			const raw = await readFile(this.file, 'utf-8')
			return JSON.parse(raw) as PackageStatePayload
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
	const tmp = join(
		dir,
		`.${base}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	)

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
