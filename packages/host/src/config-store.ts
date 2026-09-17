import { type Context as PluxelContext, type PluginNodeAddress } from '@pluxel/core'
import {
	ConfigService as CoreConfigService,
	type PluginConfigRecordSnapshot,
} from '@pluxel/core/services'
import { hash as ohash } from 'ohash'
import { SuperJSON } from 'superjson'
import { ConfigMutationRejectedError } from './config'
import { coercePluginConfigRecords } from './config-records'
import {
	assertHostStoreStorage,
	type HostDocumentStorage,
	type HostStoreStorageOptions,
} from './document-storage'

type HostStoreMode = 'memory' | 'writable' | 'readonly'
export interface PluginConfigFile {
	version: 3
	plugins: readonly PluginConfigRecordSnapshot[]
}
export type HostConfigStoreOptions = HostStoreStorageOptions &
	Readonly<{
		/** Validated seed records; an existing persisted document takes precedence. Omitted means empty. */
		initial?: readonly PluginConfigRecordSnapshot[]
	}>

/** Persistent runtime adapter over core's single config state and validation engine. */
export class HostConfigStore extends CoreConfigService {
	private readonly file = 'config.json'
	private readonly saveDelayMs = 200
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private saveScheduled = false
	private saveInFlight: Promise<void> | null = null
	private saveAgain = false
	private lastWrittenDigest: string | undefined
	private disposed = false
	private closing?: Promise<void>
	private batching = 0
	private pendingSave = false
	private readonly mode: HostStoreMode
	private readonly readonlyMode: boolean
	private readonly storage: HostDocumentStorage | undefined

	constructor(ctx: PluxelContext, options: HostConfigStoreOptions = {}) {
		super(ctx)
		assertHostStoreStorage(options)
		this.mode = options.mode ?? (options.storage ? 'writable' : 'memory')
		this.readonlyMode = this.mode === 'readonly'
		this.storage = options.storage
		if (this.mode !== 'memory' && !this.storage)
			throw new TypeError('[host] persistent config requires document storage')
		const initial = coercePluginConfigRecords(options.initial ?? [])
		if (initial.length > 0) this.replaceConfigRecords(initial)
		if (this.mode !== 'memory') this.setReadyTask(this.loadFromDisk())
		ctx.effects.defer(() => this.dispose(), { tag: 'HostConfigStore' })
	}

	protected override assertConfigMutable(action: string): void {
		if (this.disposed) throw new Error(`[ConfigService] ${action} is disabled after dispose.`)
		if (!this.readonlyMode) return
		throw new ConfigMutationRejectedError(action)
	}

	protected override onConfigChanged(_owner: PluginNodeAddress): void {
		this.requestSave()
	}

	override batch(run: () => void): void {
		this.batching++
		try {
			run()
		} finally {
			this.batching--
			if (this.batching === 0 && this.pendingSave) {
				this.pendingSave = false
				this.scheduleSave()
			}
		}
	}

	private requestSave(): void {
		if (this.mode !== 'writable' || this.disposed) return
		if (this.batching > 0) {
			this.pendingSave = true
			return
		}
		this.scheduleSave()
	}

	private scheduleSave(): void {
		if (this.disposed) return
		this.saveScheduled = true
		if (this.saveTimer) return
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null
			if (!this.saveScheduled) return
			this.saveScheduled = false
			void this.saveToDisk().catch((error: unknown) => {
				this.saveScheduled = true
				this.ctx.logger.error('ConfigService background save failed', { error })
			})
		}, this.saveDelayMs)
	}

	private cancelScheduledSave(): void {
		this.saveScheduled = false
		if (!this.saveTimer) return
		clearTimeout(this.saveTimer)
		this.saveTimer = null
	}

	/** Flush pending disk writes. Use force while disposing inside a batch. */
	override async flush(options: { force?: boolean } = {}): Promise<void> {
		if (this.mode !== 'writable') return
		try {
			const hadScheduled = this.saveScheduled || this.saveTimer !== null
			this.cancelScheduledSave()
			if (this.saveInFlight) await this.saveInFlight
			if (!hadScheduled && !this.pendingSave) return
			this.pendingSave = false
			await this.saveToDisk({ force: options.force })
		} catch (error) {
			this.saveScheduled = true
			throw error
		}
	}

	private async loadFromDisk(): Promise<void> {
		const text = await this.storage!.getText(this.file)
		if (text === undefined) {
			if (!this.readonlyMode) await this.saveToDisk()
			return
		}

		this.lastWrittenDigest = ohash(text)
		let parsed: Record<string, unknown>
		try {
			const value = SuperJSON.parse(text) as unknown
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error('persisted config must be an object')
			}
			parsed = value as Record<string, unknown>
		} catch (error) {
			if (this.readonlyMode) {
				throw new Error('[ConfigService] Persisted readonly config is malformed.', {
					cause: error,
				})
			}
			this.ctx.logger.warn('ConfigService parse failed; isolating broken config', {
				file: this.file,
				error,
			})
			await this.isolateBrokenConfigFile(text)
			this.replaceConfigRecords([])
			await this.saveToDisk()
			return
		}

		if (parsed.version !== 3) {
			throw new Error(
				`[ConfigService] Unsupported persisted config version: ${String(parsed.version)}`,
			)
		}
		this.replaceConfigRecords(coercePluginConfigRecords(parsed.plugins))
	}

	private async isolateBrokenConfigFile(content: string): Promise<void> {
		const safeTs = new Date().toISOString().replaceAll(/[:.]/g, '-')
		const brokenFile = `${this.file}.broken.${safeTs}`
		try {
			await this.storage!.put(brokenFile, content)
		} catch (error) {
			this.ctx.logger.warn('failed to isolate broken config file', {
				file: this.file,
				brokenFile,
				error,
			})
		}
	}

	private async saveToDisk(options: { force?: boolean } = {}): Promise<void> {
		if (!options.force && this.batching > 0) return

		if (this.saveInFlight) {
			this.saveAgain = true
			await this.saveInFlight
			if (this.saveAgain) {
				this.saveAgain = false
				await this.saveToDisk(options)
			}
			return
		}

		const content = SuperJSON.stringify({
			version: 3,
			plugins: this.getConfigSnapshot().plugins,
		} satisfies PluginConfigFile)
		const nextDigest = ohash(content)
		if (nextDigest === this.lastWrittenDigest && (await this.storage!.stat(this.file))) return

		const task = this.storage!.put(this.file, content, { atomic: true }).then((): undefined => {
			this.lastWrittenDigest = nextDigest
			return undefined
		})
		this.saveInFlight = task.finally(() => {
			this.saveInFlight = null
		})
		await this.saveInFlight

		if (this.saveAgain) {
			this.saveAgain = false
			await this.saveToDisk(options)
		}
	}

	dispose(): Promise<void> {
		return (this.closing ??= (async () => {
			this.disposed = true
			try {
				await this.ready
			} catch {
				/* Preparation reports its original failure. */
			}
			await this.flush({ force: true })
		})())
	}
}
