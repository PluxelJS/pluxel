import { type FSWatcher, watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { type Context, Injectable } from '@pluxel/core'
import type { BaseItem, PersistenceAdapter } from '@signaldb/core'
import createFilesystemAdapter from '@signaldb/fs'
import { SuperJSON } from 'superjson'

const serviceName = 'pluginData' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			pluginData: PluginDataService
		}
	}
}

type MultiCollectionStore = { collections: Record<string, unknown> }
type CollectionPersistenceMode = 'perCollection' | 'shared'

@Injectable({ key: serviceName })
export class PluginDataService {
	private baseDir: string
	private watchers = new Map<string, Set<FSWatcher>>()

	constructor(public ctx: Context) {
		const cfg = (ctx.config as any)?.pluginData ?? {}
		const dir = cfg.dir ?? cfg.baseDir ?? '.pluxel/plugin-data'
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
		const ns = this.normalizeNamespace(this.ctx.pluginInfo.id)
		const file = this.fileForNamespace(ns)

		await mkdir(dirname(file), { recursive: true })
		return createFilesystemAdapter<T, string>(file, {
			serialize: options?.serialize ?? ((items) => SuperJSON.stringify(items)),
			deserialize: (txt) => {
				try {
					return (options?.deserialize?.(txt) ?? (SuperJSON.parse(txt) as T[]) ?? []) as T[]
				} catch {
					return []
				}
			},
		})
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
		const ns = this.normalizeNamespace(this.ctx.pluginInfo.id)
		const mode: CollectionPersistenceMode = options?.mode ?? 'perCollection'

		if (mode === 'perCollection') {
			const file = this.fileForCollection(ns, collection)
			const sharedFile = this.fileForNamespace(ns) // 读取时作为降级 fallback
			await mkdir(dirname(file), { recursive: true })

			const loadItems = async (): Promise<T[]> => {
				// 优先读取独立文件
				try {
					const text = (await readFile(file, 'utf8')).trim()
					if (text) {
						try {
							const parsed = JSON.parse(text)
							if (Array.isArray(parsed)) return parsed as T[]
							if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).items)) {
								return (parsed as any).items as T[]
							}
						} catch {
							// fallthrough
						}
						try {
							return (options?.deserialize?.(text) ?? SuperJSON.parse(text) ?? []) as T[]
						} catch {
							// ignore parse error
						}
					}
				} catch {
					// file missing
				}

				// 回退读取 shared 文件中的该 collection
				try {
					const text = (await readFile(sharedFile, 'utf8')).trim()
					if (text) {
						try {
							const parsed = JSON.parse(text)
							if (parsed && typeof parsed === 'object') {
								if (Array.isArray(parsed[collection])) {
									return parsed[collection] as T[]
								}
								if (parsed.collections && typeof parsed.collections === 'object') {
									const raw = parsed.collections[collection]
									if (Array.isArray(raw)) return raw as T[]
									if (typeof raw === 'string') {
										try {
											return (options?.deserialize?.(raw) ?? JSON.parse(raw)) as T[]
										} catch {
											return []
										}
									}
								}
							}
						} catch {
							// ignore
						}
						try {
							const parsed = SuperJSON.parse<any>(text)
							if (parsed?.collections?.[collection]) {
								const raw = parsed.collections[collection]
								if (Array.isArray(raw)) return raw as T[]
								if (typeof raw === 'string') {
									try {
										return (options?.deserialize?.(raw) ?? JSON.parse(raw)) as T[]
									} catch {
										return []
									}
								}
							}
						} catch {
							// ignore
						}
					}
				} catch {
					// no shared file
				}

				return []
			}

			let watcher: FSWatcher | null = null

			return {
				load: async () => ({ items: await loadItems() }),
				save: async (items) => {
					const serialized = options?.serialize ? options.serialize(items) : items
					await writeFile(
						file,
						typeof serialized === 'string' ? serialized : JSON.stringify(serialized, null, 2),
						'utf8',
					)
				},
				register: async (onChange) => {
					const notify = async () => {
						await onChange({ items: await loadItems() })
					}
					await notify()
					try {
						watcher = watch(file, { persistent: false }, () => {
							void notify()
						})
						if (!this.watchers.has(file)) this.watchers.set(file, new Set())
						this.watchers.get(file)?.add(watcher)
					} catch {
						// ignore watcher errors
					}
				},
				unregister: async () => {
					if (watcher) {
						try {
							watcher.close()
						} catch {}
						const set = this.watchers.get(file)
						set?.delete(watcher)
						if (set && set.size === 0) this.watchers.delete(file)
						watcher = null
					}
				},
			}
		}

		// shared 模式：单文件存放多个 Collection
		const file = this.fileForNamespace(ns)
		const legacyFile = this.fileForLegacyCollection(ns, collection)
		await mkdir(dirname(file), { recursive: true })

		const loadStore = async (): Promise<MultiCollectionStore> => {
			try {
				const text = (await readFile(file, 'utf8')).trim()
				if (!text) return { collections: {} }
				try {
					const parsed = JSON.parse(text)
					if (Array.isArray(parsed)) {
						return { collections: { [collection]: parsed } }
					}
					if (parsed && typeof parsed === 'object') {
						const maybeCollections = (parsed as any).collections
						if (maybeCollections && typeof maybeCollections === 'object') {
							return { collections: maybeCollections as Record<string, unknown> }
						}
						// 旧格式：顶层就是各 collection
						return { collections: parsed as Record<string, unknown> }
					}
				} catch {
					// fall through
				}
				const parsed = SuperJSON.parse<MultiCollectionStore>(text)
				if (parsed && typeof parsed === 'object') {
					if (parsed.collections && typeof parsed.collections === 'object') {
						return { collections: parsed.collections }
					}
					return { collections: parsed as unknown as Record<string, unknown> }
				}
			} catch {
				// file not found or unreadable
				// legacy fallback
				try {
					const legacyText = (await readFile(legacyFile, 'utf8')).trim()
					if (legacyText) {
						const parsed = JSON.parse(legacyText)
						if (Array.isArray(parsed)) {
							return { collections: { [collection]: parsed } }
						}
						if (parsed && typeof parsed === 'object') {
							return { collections: parsed as Record<string, unknown> }
						}
					}
				} catch {
					// ignore legacy errors
				}
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
			await writeFile(file, content, 'utf8')
		}

		let watcher: FSWatcher | null = null

		return {
			load: async () => {
				const store = await loadStore()
				return { items: extractItems(store) }
			},
			save: async (items) => {
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
					watcher = watch(file, { persistent: false }, () => {
						void notify()
					})
					if (!this.watchers.has(file)) this.watchers.set(file, new Set())
					this.watchers.get(file)?.add(watcher)
				} catch {
					// ignore watcher errors (e.g., missing file)
				}
			},
			unregister: async () => {
				if (watcher) {
					try {
						watcher.close()
					} catch {}
					const set = this.watchers.get(file)
					set?.delete(watcher)
					if (set && set.size === 0) this.watchers.delete(file)
					watcher = null
				}
			},
		}
	}

	/** 获取对应 namespace 的默认存储文件路径（已规范化）。 */
	getFilePath(): string {
		return this.fileForNamespace(this.normalizeNamespace(this.ctx.pluginInfo.id))
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

	private fileForLegacyCollection(namespace: string, collection: string): string {
		const safeNs = this.normalizeNamespace(namespace)
		const safeCol = this.normalizeNamespace(collection)
		return resolve(this.baseDir, `${safeNs}.${safeCol}.json`)
	}

	private normalizeNamespace(ns: string): string {
		const trimmed = ns || 'default'
		return basename(trimmed).replace(/[^A-Za-z0-9_-]/g, '_')
	}
}
