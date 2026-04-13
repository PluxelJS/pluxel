import { type Context as PluxelContext, Injectable } from '@pluxel/core'
import type { BaseItem, PersistenceAdapter } from '@signaldb/core'
import { watch, type FSWatcher } from 'chokidar'
import { basename, resolve } from 'pathe'
import { SuperJSON } from 'superjson'
import { resolveRuntimeStoragePaths } from '../runtime/paths'

const serviceName = 'pluginData' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			pluginData?: PluginDataServiceConfig
		}
		interface Services {
			pluginData: PluginDataService
		}
	}
}

export type PluginDataServiceConfig = {
	/**
	 * Base directory for plugin persistence data.
	 *
	 * @default runtime storage layout ("data/plugin-data")
	 */
	dir?: string
	enabled?: boolean
}

type MultiCollectionStore = { collections: Record<string, unknown> }
type CollectionPersistenceMode = 'perCollection' | 'shared'

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getRecordProp(value: Record<string, unknown>, key: string): unknown {
	return value[key]
}

function isEnoent(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false
	if (!('code' in err)) return false
	return (err as { code?: unknown }).code === 'ENOENT'
}

@Injectable({ key: serviceName })
export class PluginDataService {
	private readonly baseDir: string
	private readonly watchers = new Map<string, Set<FSWatcher>>()
	private readonly enabled: boolean

	constructor(public ctx: PluxelContext) {
		const cfg = ctx.config.pluginData ?? {}
		this.enabled = cfg.enabled !== false
		const dir = cfg.dir ?? resolveRuntimeStoragePaths(process.cwd()).pluginDataDir
		this.baseDir = resolve(dir)
	}

	/**
	 * 最简单的持久化：一个插件一个文件，直接序列化整个 Collection。
	 * 适合单 Collection 场景或演示用途。
	 */
	async persistence<T extends BaseItem<string> = BaseItem<string>>(options?: {
		serialize?: (items: T[]) => string
		deserialize?: (txt: string) => T[]
	}): Promise<PersistenceAdapter<T, string>> {
		if (!this.enabled) {
			return {
				load: async () => ({ items: [] }),
				save: async () => {},
				register: async () => {},
				unregister: async () => {},
			}
		}
		const ns = this.normalizeNamespace(this.ctx.pluginInfo?.id ?? 'default')
		const file = this.fileForNamespace(ns)

		const serialize = options?.serialize ?? ((items: T[]) => SuperJSON.stringify(items))
		const deserialize = (txt: string): T[] => {
			try {
				return (options?.deserialize?.(txt) ?? (SuperJSON.parse(txt) as T[]) ?? []) as T[]
			} catch {
				return []
			}
		}

		const readItems = async (): Promise<T[]> => {
			const txt = await this.readTextOptional(file)
			if (!txt) return []
			return deserialize(txt.trim())
		}

		let watcher: FSWatcher | null = null

		return {
			load: async () => ({ items: await readItems() }),
			save: async (items, _changes) => {
				await this.ctx.root.fs.writeTextAtomic(file, serialize(items))
			},
			register: async (onChange) => {
				const notify = async () => {
					await onChange({ items: await readItems() })
				}
				await notify()
				try {
					watcher = watch(file, {
						ignoreInitial: true,
						awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
					})
						.on('add', () => void notify())
						.on('change', () => void notify())
					if (!this.watchers.has(file)) this.watchers.set(file, new Set())
					this.watchers.get(file)?.add(watcher)
				} catch {
					// ignore watcher errors (e.g., unsupported runtime / missing file)
				}
			},
			unregister: async () => {
				if (!watcher) return
				await Promise.resolve(watcher.close()).catch((): undefined => undefined)
				const set = this.watchers.get(file)
				set?.delete(watcher)
				if (set && set.size === 0) this.watchers.delete(file)
				watcher = null
			},
		}
	}

	/**
	 * 多 Collection 持久化。
	 * 默认每个 Collection 一个文件（性能友好、隔离好），也支持 shared 模式共用单文件。
	 */
	async persistenceForCollection<T extends BaseItem<string> = BaseItem<string>>(
		collection: string,
		options?: {
			serialize?: (items: T[]) => string
			deserialize?: (txt: string) => T[]
			mode?: CollectionPersistenceMode
		},
	): Promise<PersistenceAdapter<T, string>> {
		if (!this.enabled) {
			return {
				load: async () => ({ items: [] }),
				save: async () => {},
				register: async () => {},
				unregister: async () => {},
			}
		}
		const ns = this.normalizeNamespace(this.ctx.pluginInfo?.id ?? 'default')
		const mode: CollectionPersistenceMode = options?.mode ?? 'perCollection'

		if (mode === 'perCollection') {
			const file = this.fileForCollection(ns, collection)
			const sharedFile = this.fileForNamespace(ns)

			const loadItems = async (): Promise<T[]> => {
				const raw = await this.readTextOptional(file)
				const text = raw?.trim()
				if (text?.length) {
					try {
						const parsed = JSON.parse(text)
						if (Array.isArray(parsed)) return parsed as T[]
						if (isRecord(parsed)) {
							const items = getRecordProp(parsed, 'items')
							if (Array.isArray(items)) return items as T[]
						}
					} catch {
					}
					try {
						return (options?.deserialize?.(text) ?? SuperJSON.parse(text) ?? []) as T[]
					} catch {
					}
				}

				const sharedRawText = await this.readTextOptional(sharedFile)
				const sharedText = sharedRawText?.trim()
				if (sharedText?.length) {
					try {
						const parsed = JSON.parse(sharedText)
						if (isRecord(parsed)) {
							const direct = getRecordProp(parsed, collection)
							if (Array.isArray(direct)) return direct as T[]

							const collections = getRecordProp(parsed, 'collections')
							if (isRecord(collections)) {
								const collectionValue = getRecordProp(collections, collection)
								if (Array.isArray(collectionValue)) return collectionValue as T[]
								if (typeof collectionValue === 'string') {
									try {
										return (options?.deserialize?.(collectionValue) ??
											JSON.parse(collectionValue)) as T[]
									} catch {
										return []
									}
								}
							}
						}
					} catch {
					}
					try {
						const parsed = SuperJSON.parse<unknown>(sharedText)
						if (isRecord(parsed)) {
							const collections = getRecordProp(parsed, 'collections')
							if (isRecord(collections)) {
								const collectionValue = getRecordProp(collections, collection)
								if (Array.isArray(collectionValue)) return collectionValue as T[]
								if (typeof collectionValue === 'string') {
									try {
										return (options?.deserialize?.(collectionValue) ??
											JSON.parse(collectionValue)) as T[]
									} catch {
										return []
									}
								}
							}
						}
					} catch {
					}
				}

				return []
			}

			let watcher: FSWatcher | null = null

			return {
				load: async () => ({ items: await loadItems() }),
				save: async (items, _changes) => {
					const serialized = options?.serialize ? options.serialize(items) : items
					await this.ctx.root.fs.writeTextAtomic(
						file,
						typeof serialized === 'string' ? serialized : JSON.stringify(serialized, null, 2),
					)
				},
				register: async (onChange) => {
					const notify = async () => {
						await onChange({ items: await loadItems() })
					}
					await notify()
					try {
						watcher = watch(file, {
							ignoreInitial: true,
							awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
						})
							.on('add', () => void notify())
							.on('change', () => void notify())
						if (!this.watchers.has(file)) this.watchers.set(file, new Set())
						this.watchers.get(file)?.add(watcher)
					} catch {
					}
				},
				unregister: async () => {
					if (!watcher) return
					await Promise.resolve(watcher.close()).catch((): undefined => undefined)
					const set = this.watchers.get(file)
					set?.delete(watcher)
					if (set && set.size === 0) this.watchers.delete(file)
					watcher = null
				},
			}
		}

		const file = this.fileForNamespace(ns)
		const loadStore = async (): Promise<MultiCollectionStore> => {
			const rawText = await this.readTextOptional(file)
			const text = rawText?.trim()
			if (!text?.length) return { collections: {} }

			try {
				const parsed = JSON.parse(text)
				if (Array.isArray(parsed)) {
					return { collections: { [collection]: parsed } }
				}
				if (isRecord(parsed)) {
					const maybeCollections = getRecordProp(parsed, 'collections')
					if (isRecord(maybeCollections)) {
						return { collections: maybeCollections }
					}
					return { collections: parsed }
				}
			} catch {
			}

			try {
				const parsed = SuperJSON.parse<MultiCollectionStore>(text)
				if (parsed && typeof parsed === 'object') {
					if (parsed.collections && typeof parsed.collections === 'object') {
						return { collections: parsed.collections }
					}
					return { collections: parsed as unknown as Record<string, unknown> }
				}
			} catch {
			}
			return { collections: {} }
		}

		const extractItems = (store: MultiCollectionStore): T[] => {
			const raw = store.collections?.[collection]
			if (typeof raw === 'string') {
				try {
					return (options?.deserialize?.(raw) ?? JSON.parse(raw)) as T[]
				} catch {
					return []
				}
			}
			if (Array.isArray(raw)) return raw as T[]
			return []
		}

		const saveStore = async (store: MultiCollectionStore) => {
			const content = JSON.stringify(store, null, 2)
			await this.ctx.root.fs.writeTextAtomic(file, content)
		}

		let watcher: FSWatcher | null = null

		return {
			load: async () => {
				const store = await loadStore()
				return { items: extractItems(store) }
			},
			save: async (items, _changes) => {
				const store = await loadStore()
				const serialized = options?.serialize ? options.serialize(items) : items
				store.collections = store.collections ?? {}
				store.collections[collection] = serialized
				await saveStore(store)
			},
			register: async (onChange) => {
				const notify = async () => {
					const store = await loadStore()
					await onChange({ items: extractItems(store) })
				}
				await notify()
				try {
					watcher = watch(file, {
						ignoreInitial: true,
						awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
					})
						.on('add', () => void notify())
						.on('change', () => void notify())
					if (!this.watchers.has(file)) this.watchers.set(file, new Set())
					this.watchers.get(file)?.add(watcher)
				} catch {
				}
			},
			unregister: async () => {
				if (!watcher) return
				await Promise.resolve(watcher.close()).catch((): undefined => undefined)
				const set = this.watchers.get(file)
				set?.delete(watcher)
				if (set && set.size === 0) this.watchers.delete(file)
				watcher = null
			},
		}
	}

	getFilePath(): string {
		return this.fileForNamespace(this.normalizeNamespace(this.ctx.pluginInfo?.id ?? 'default'))
	}

	private fileForNamespace(namespace: string): string {
		const safe = this.normalizeNamespace(namespace)
		return resolve(this.baseDir, `${safe}.json`)
	}

	private fileForCollection(namespace: string, collection: string): string {
		const safeNs = this.normalizeNamespace(namespace)
		const safeCol = this.normalizeNamespace(collection)
		return resolve(this.baseDir, `${safeNs}.${safeCol}.json`)
	}

	private async readTextOptional(path: string | null): Promise<string | null> {
		if (!path) return null
		try {
			return await this.ctx.root.fs.readText(path)
		} catch (err) {
			if (isEnoent(err)) return null
			throw err
		}
	}

	private normalizeNamespace(ns: string): string {
		const trimmed = ns || 'default'
		return basename(trimmed).replaceAll(/[^A-Za-z0-9_-]/g, '_')
	}
}
