import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import { basename, dirname, join as joinPath, resolve } from 'node:path'
import { type Context, Injectable } from '@pluxel/core'
import { debounce } from '@tanstack/pacer'
import chokidar, { type FSWatcher } from 'chokidar'
import { SuperJSON } from 'superjson'

const serviceName = 'pluginData' as const

declare module '@pluxel/core' {
	interface Context {
		[serviceName]: PluginDataService
	}
}

type DataShape = Record<string, Record<string, unknown>>

@Injectable({ key: serviceName })
export class PluginDataService {
	private data: DataShape = {}
	private watcher!: FSWatcher
	private saveDebounced: () => void

	private writingNow = false
	private batching = 0
	private filePath = 'plugins.data.json'

	constructor(private ctx: Context) {
		const config = this.ctx.config as any
		const file =
			typeof config?.pluginDataPath === 'string' && config.pluginDataPath.trim()
				? config.pluginDataPath
				: typeof config?.pluginData?.path === 'string' && config.pluginData.path.trim()
					? config.pluginData.path
					: 'plugins.data.json'

		const resolvedFile = resolve(file)
		this.filePath = resolvedFile

		void this.loadFromDisk(resolvedFile)
		this.saveDebounced = debounce(() => this.saveToDisk(resolvedFile), { wait: 200 })

		this.watcher = chokidar
			.watch(resolvedFile, {
				ignoreInitial: true,
				awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
			})
			.on('change', () => this.onDiskChange(resolvedFile))
	}

	// —— I/O —— //

	private clone<T>(val: T): T {
		if (val == null || typeof val !== 'object') return val
		if (Array.isArray(val)) return val.map((v) => this.clone(v)) as unknown as T
		return { ...(val as Record<string, unknown>) } as T
	}

	private async loadFromDisk(file: string) {
		try {
			const txt = import.meta.hot ? await fs.readFile(file, 'utf-8') : readFileSync(file, 'utf-8')
			const parsed = SuperJSON.parse(txt)
			if (parsed && typeof parsed === 'object') {
				const next: DataShape = {}
				for (const [name, payload] of Object.entries(parsed as Record<string, unknown>)) {
					if (!payload || typeof payload !== 'object') continue
					next[name] = this.clone(payload as Record<string, unknown>)
				}
				this.data = next
			} else {
				this.data = {}
			}
		} catch {
			this.data = {}
			await this.saveToDisk(file)
		}
	}

	private async saveToDisk(file: string) {
		if (this.batching > 0) return
		this.writingNow = true
		const targetDir = dirname(file)
		const base = basename(file)
		const tmp = joinPath(
			targetDir,
			`.${base}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
		)
		try {
			await fs.mkdir(targetDir, { recursive: true })
			const content = SuperJSON.stringify(this.data)
			await fs.writeFile(tmp, content, 'utf-8')
			await fs.rename(tmp, file)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code
			if (code === 'EXDEV') {
				await fs.copyFile(tmp, file)
				await fs.rm(tmp, { force: true }).catch(() => {})
			} else {
				await fs.rm(tmp, { force: true }).catch(() => {})
				throw err
			}
		} finally {
			setTimeout(() => {
				this.writingNow = false
			}, 60)
		}
	}

	private async onDiskChange(file: string) {
		if (this.writingNow) return
		await this.loadFromDisk(file)
	}

	// —— API —— //

	get<T extends object = Record<string, unknown>>(name = this.ctx.pluginInfo.name): Readonly<T> {
		if (!name) return {} as Readonly<T>
		return (this.data[name] ?? {}) as Readonly<T>
	}

	getAll(): Readonly<DataShape> {
		return this.data
	}

	batch(run: () => void) {
		this.batching++
		try {
			run()
		} finally {
			this.batching--
			if (this.batching === 0) this.saveDebounced()
		}
	}

	patch<T extends object = Record<string, unknown>>(name: string, partial: Partial<T>) {
		if (!name) throw new Error('[PluginData] name is required')
		const entry = (this.data[name] ??= {})
		Object.assign(entry, partial)
		this.saveDebounced()
	}

	replace<T extends object = Record<string, unknown>>(name: string, next: T) {
		if (!name) throw new Error('[PluginData] name is required')
		this.data[name] = this.clone(next)
		this.saveDebounced()
	}

	delete(name: string) {
		if (!name) return
		if (this.data[name] === undefined) return
		delete this.data[name]
		this.saveDebounced()
	}
}
