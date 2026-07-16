import { type Context as PluxelContext, Injectable, OverrideOf } from '@pluxel/core'
import { ConfigService as CoreConfigService } from '@pluxel/core/services'
import { hash as ohash } from 'ohash'
import { SuperJSON } from 'superjson'
import type { PersistenceNamespace } from './persistence/PersistenceService'

export interface PluginConfigFile {
	version: 1
	plugins: Record<string, Record<string, unknown>>
}

export type ConfigServiceMode = 'file' | 'memory' | 'readonly'

export interface ConfigServiceConfig {
	mode?: ConfigServiceMode
	snapshot?: Partial<{
		plugins: Record<string, Record<string, unknown>>
	}>
}

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			configService?: ConfigServiceConfig
		}
	}
}

/** Persistent runtime adapter over core's single config state and validation engine. */
@Injectable
@OverrideOf(CoreConfigService)
export class ConfigService extends CoreConfigService {
	private readonly file = 'config.json'
	private readonly saveDelayMs = 200
	private saveTimer: ReturnType<typeof setTimeout> | null = null
	private saveScheduled = false
	private saveInFlight: Promise<void> | null = null
	private saveAgain = false
	private lastWrittenDigest: string | undefined
	private disposed = false
	private batching = 0
	private pendingSave = false
	private readonly mode: ConfigServiceMode
	private readonly readonlyMode: boolean
	private readonly storage: PersistenceNamespace

	constructor(ctx: PluxelContext, cfg: ConfigServiceConfig = {}) {
		super(ctx)

		this.mode = cfg.mode ?? defaultConfigServiceMode(ctx.root.persistence.capability)
		this.readonlyMode = this.mode === 'readonly'
		this.storage = ctx.root.persistence.namespace('config')

		if (cfg.snapshot?.plugins) this.replaceConfigRecords(cfg.snapshot.plugins)
		if (this.mode === 'file') this.setReadyTask(this.loadFromDisk())

		this.ctx.effects.defer(() => this.dispose(), { tag: 'ConfigService' })
	}

	protected override assertConfigMutable(action: string): void {
		if (!this.readonlyMode) return
		throw new Error(`[ConfigService] ${action} is disabled in readonly mode.`)
	}

	protected override onConfigChanged(_name: string): void {
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
		if (this.mode !== 'file' || this.disposed) return
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
			void this.saveToDisk()
		}, this.saveDelayMs)
	}

	private cancelScheduledSave(): void {
		this.saveScheduled = false
		if (!this.saveTimer) return
		clearTimeout(this.saveTimer)
		this.saveTimer = null
	}

	/** Flush pending disk writes. Use force while disposing inside a batch. */
	async flush(options: { force?: boolean } = {}): Promise<void> {
		if (this.mode !== 'file') return
		const hadScheduled = this.saveScheduled || this.saveTimer !== null
		this.cancelScheduledSave()
		if (this.saveInFlight) await this.saveInFlight.catch((): void => undefined)
		if (!hadScheduled && !this.pendingSave) return
		this.pendingSave = false
		await this.saveToDisk({ force: options.force }).catch((): void => undefined)
	}

	private async loadFromDisk(): Promise<void> {
		const text = await this.storage.getText(this.file)
		if (text === undefined) {
			await this.saveToDisk()
			return
		}

		this.lastWrittenDigest = ohash(text)
		let parsed: Partial<PluginConfigFile>
		try {
			parsed = SuperJSON.parse(text) as Partial<PluginConfigFile>
		} catch (error) {
			this.ctx.logger.warn('ConfigService parse failed; isolating broken config', {
				file: this.file,
				error,
			})
			await this.isolateBrokenConfigFile(text)
			this.replaceConfigRecords({})
			await this.saveToDisk()
			return
		}

		this.replaceConfigRecords(parsed.plugins ? coercePlugins(parsed.plugins) : {})
	}

	private async isolateBrokenConfigFile(content: string): Promise<void> {
		const safeTs = new Date().toISOString().replaceAll(/[:.]/g, '-')
		const brokenFile = `${this.file}.broken.${safeTs}`
		try {
			await this.storage.put(brokenFile, content)
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
			await this.saveInFlight.catch((): void => undefined)
			if (this.saveAgain) {
				this.saveAgain = false
				await this.saveToDisk(options)
			}
			return
		}

		const content = SuperJSON.stringify({
			version: 1,
			plugins: this.getConfigSnapshot().plugins,
		} satisfies PluginConfigFile)
		const nextDigest = ohash(content)
		if (nextDigest === this.lastWrittenDigest && (await this.storage.stat(this.file))) return

		const task = this.storage.put(this.file, content).then((): undefined => {
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

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		await this.flush({ force: true }).catch((): void => undefined)
	}
}

function defaultConfigServiceMode(
	capability: PluxelContext.RootServices['persistence']['capability'],
): ConfigServiceMode {
	return capability === 'readonly' ? 'readonly' : 'file'
}

function coercePlugins(input: Record<string, unknown>): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = Object.create(null)
	for (const [name, raw] of Object.entries(input)) {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
		const maybe = raw as Record<string, unknown>
		const record = maybe.configRecord
		out[name] = Object.assign(
			Object.create(null),
			record && typeof record === 'object' && !Array.isArray(record) ? record : raw,
		)
	}
	return out
}
