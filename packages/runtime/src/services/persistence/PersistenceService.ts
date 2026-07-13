import { type Context as PluxelContext, RootService } from '@pluxel/core'
import { basename, isAbsolute, join, resolve } from 'pathe'

const serviceName = 'persistence' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			[serviceName]?: PersistenceServiceConfig
		}
		interface RootServices {
			[serviceName]: PersistenceService
		}
	}
}

export type PersistenceCapability = 'durable' | 'ephemeral' | 'readonly'

export type PersistenceEntry = {
	key: string
	kind: 'file' | 'directory'
	size?: number
	updatedAt?: Date
}

export type PersistenceRequirement = {
	durable?: boolean
	writable?: boolean
}

export type PersistenceNamespace = {
	get(key: string): Promise<Uint8Array | undefined>
	getText(key: string): Promise<string | undefined>
	put(key: string, value: Uint8Array | string, options?: { atomic?: boolean }): Promise<void>
	delete(key: string): Promise<void>
	list(prefix?: string): AsyncIterable<PersistenceEntry>
	stat(key: string): Promise<PersistenceEntry | undefined>
}

export type PersistenceBackend = {
	capability: PersistenceCapability
	namespace(name: string): PersistenceNamespace
	preflight?(requirement?: PersistenceRequirement): Promise<void>
}

export type PersistenceServiceConfig =
	| string
	| { mode: 'memory' }
	| { mode: 'custom'; backend: PersistenceBackend }
	| ({ mode: 'readonly' } & ({ backend: PersistenceBackend } | { dir: string }))

export type WorkspacePersistenceBackendOptions = {
	capability?: PersistenceCapability
	root?: string
}

export type MemoryPersistenceBackendOptions = {
	warnOnWrite?: false | ((operation: 'put' | 'delete', namespace: string, key: string) => void)
}

export class PersistenceError extends Error {
	public readonly code: 'ENOENT' | 'IO' | 'READONLY' | 'UNAVAILABLE'
	constructor(code: PersistenceError['code'], message: string, options?: { cause?: unknown }) {
		super(message)
		this.name = 'PersistenceError'
		this.code = code
		if (options?.cause !== undefined) (this as unknown as { cause?: unknown }).cause = options.cause
	}
}

export type WorkspacePersistenceBackendFs = {
	exists(path: string): boolean
	readText(path: string): Promise<string>
	writeTextAtomic(path: string, text: string): Promise<void>
	readBytes(path: string): Promise<Uint8Array>
	writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void>
	unlink(path: string): Promise<void>
	readdir(path: string): Promise<string[]>
	stat(path: string): Promise<{
		type: 'file' | 'dir' | 'directory' | 'other' | 'missing'
		size?: number
		mtimeMs?: number
	}>
}

function utf8Encode(s: string): Uint8Array {
	return new TextEncoder().encode(s)
}

function utf8Decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

function copyBytes(bytes: Uint8Array): Uint8Array {
	return Uint8Array.from(bytes)
}

function getErrnoCode(error: unknown): unknown {
	if (!error || typeof error !== 'object') return undefined
	if (!('code' in error)) return undefined
	return (error as { code?: unknown }).code
}

function normalizeNamespace(name: string): string {
	const raw = String(name || 'default').trim()
	return (
		raw
			.split(/[\\/]+/g)
			.filter(Boolean)
			.map((part) => basename(part).replaceAll(/[^A-Za-z0-9_.-]/g, '_'))
			.join('/') || 'default'
	)
}

function normalizeKey(key: string): string {
	return String(key || '')
		.replaceAll('\\', '/')
		.replace(/^\/+/, '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function keyMatchesPrefix(key: string, prefix: string): boolean {
	const clean = normalizeKey(prefix)
	if (!clean) return true
	return key === clean || key.startsWith(`${clean}/`)
}

function bytesToHex(bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
	return out
}

function randomHex(bytes: number): string {
	const c = (
		globalThis as unknown as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
	).crypto
	if (typeof c?.getRandomValues === 'function') {
		const buf = new Uint8Array(bytes)
		c.getRandomValues(buf)
		return bytesToHex(buf)
	}
	return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
}

export function createMemoryPersistenceBackend(
	options: MemoryPersistenceBackendOptions = {},
): PersistenceBackend {
	const data = new Map<string, Uint8Array>()
	const keyFor = (namespace: string, key: string) =>
		`${normalizeNamespace(namespace)}/${normalizeKey(key)}`
	let warned = false
	const warnOnWrite = (operation: 'put' | 'delete', namespace: string, key: string) => {
		if (warned || !options.warnOnWrite) return
		warned = true
		options.warnOnWrite(operation, namespace, key)
	}

	return {
		capability: 'ephemeral',
		namespace(name) {
			const namespace = normalizeNamespace(name)
			return {
				get: async (key) => {
					const value = data.get(keyFor(namespace, key))
					return value ? copyBytes(value) : undefined
				},
				getText: async (key) => {
					const value = data.get(keyFor(namespace, key))
					return value ? utf8Decode(value) : undefined
				},
				put: async (key, value) => {
					warnOnWrite('put', namespace, key)
					data.set(
						keyFor(namespace, key),
						typeof value === 'string' ? utf8Encode(value) : copyBytes(value),
					)
				},
				delete: async (key) => {
					warnOnWrite('delete', namespace, key)
					data.delete(keyFor(namespace, key))
				},
				list: async function* (prefix = '') {
					const nsRoot = `${namespace}/`
					for (const fullKey of [...data.keys()].sort()) {
						if (!fullKey.startsWith(nsRoot)) continue
						const key = fullKey.slice(nsRoot.length)
						if (!keyMatchesPrefix(key, prefix)) continue
						yield {
							key,
							kind: 'file',
							size: data.get(fullKey)?.byteLength,
						}
					}
				},
				stat: async (key) => {
					const value = data.get(keyFor(namespace, key))
					return value ? { key, kind: 'file', size: value.byteLength } : undefined
				},
			}
		},
		preflight: async (requirement) => {
			if (requirement?.durable) {
				throw new PersistenceError(
					'UNAVAILABLE',
					'[PersistenceService] durable persistence required, but the configured memory backend is ephemeral. Fix: configure a persistence root path, pass persistence: { mode: "custom", backend }, or remove the durable preflight requirement.',
				)
			}
		},
	}
}

function createLazyNodeWorkspaceFsBackend(): WorkspacePersistenceBackendFs {
	let task: Promise<WorkspacePersistenceBackendFs> | undefined
	const load = async () => {
		task ??= import('../../runtime/workspace-fs')
			.then((mod) => mod.createNodeWorkspaceFsBackend())
			.catch((cause) => {
				throw new PersistenceError(
					'UNAVAILABLE',
					'[PersistenceService] Node file persistence is unavailable in this runtime. Fix: pass persistence: { mode: "custom", backend } for this host, or use persistence: { mode: "memory" } for ephemeral writes.',
					{ cause },
				)
			})
		return await task
	}
	const withFs = async <T>(
		operation: (fs: WorkspacePersistenceBackendFs) => Promise<T>,
	): Promise<T> => {
		const fs = await load()
		return await operation(fs)
	}

	return {
		exists: () => false,
		readText: async (path) => await withFs(async (fs) => await fs.readText(path)),
		writeTextAtomic: async (path, text) =>
			await withFs(async (fs) => await fs.writeTextAtomic(path, text)),
		readBytes: async (path) => await withFs(async (fs) => await fs.readBytes(path)),
		writeBytesAtomic: async (path, bytes) =>
			await withFs(async (fs) => await fs.writeBytesAtomic(path, bytes)),
		unlink: async (path) => await withFs(async (fs) => await fs.unlink(path)),
		readdir: async (path) => await withFs(async (fs) => await fs.readdir(path)),
		stat: async (path) => await withFs(async (fs) => await fs.stat(path)),
	}
}

export function createNodePersistenceBackend(
	options: WorkspacePersistenceBackendOptions = {},
): PersistenceBackend {
	return createWorkspacePersistenceBackend(createLazyNodeWorkspaceFsBackend(), options)
}

export function createReadonlyPersistenceBackend(delegate: PersistenceBackend): PersistenceBackend {
	return {
		capability: 'readonly',
		namespace(name) {
			const ns = delegate.namespace(name)
			return {
				get: (key) => ns.get(key),
				getText: (key) => ns.getText(key),
				put: async () => {
					throw new PersistenceError(
						'READONLY',
						'[PersistenceService] write requested, but the configured persistence backend is readonly. Fix: pass a writable backend or use persistence: { mode: "memory" } for ephemeral writes.',
					)
				},
				delete: async () => {
					throw new PersistenceError(
						'READONLY',
						'[PersistenceService] delete requested, but the configured persistence backend is readonly. Fix: pass a writable backend or avoid mutating persistence state.',
					)
				},
				list: (prefix) => ns.list(prefix),
				stat: (key) => ns.stat(key),
			}
		},
		preflight: async (requirement) => {
			if (requirement?.writable) {
				throw new PersistenceError(
					'READONLY',
					'[PersistenceService] writable persistence required, but the configured backend is readonly. Fix: pass a writable backend or remove the writable preflight requirement.',
				)
			}
			await delegate.preflight?.(requirement)
		},
	}
}

export function createWorkspacePersistenceBackend(
	fs: WorkspacePersistenceBackendFs,
	options: WorkspacePersistenceBackendOptions = {},
): PersistenceBackend {
	const capability = options.capability ?? 'durable'
	const root = options.root ? resolve(options.root) : ''
	return {
		capability,
		namespace(name) {
			const prefix = normalizeNamespace(name)
			const pathFor = (key: string) => {
				const normalized = isAbsolute(key) ? key : join(prefix, normalizeKey(key))
				if (!root || isAbsolute(normalized)) return normalized
				return join(root, normalized)
			}
			return {
				get: async (key) => {
					try {
						return await fs.readBytes(pathFor(key))
					} catch (cause) {
						if (getErrnoCode(cause) === 'ENOENT') return undefined
						throw cause
					}
				},
				getText: async (key) => {
					try {
						return await fs.readText(pathFor(key))
					} catch (cause) {
						if (getErrnoCode(cause) === 'ENOENT') return undefined
						throw cause
					}
				},
				put: async (key, value) => {
					if (typeof value === 'string') await fs.writeTextAtomic(pathFor(key), value)
					else await fs.writeBytesAtomic(pathFor(key), value)
				},
				delete: async (key) => {
					try {
						await fs.unlink(pathFor(key))
					} catch (cause) {
						if (getErrnoCode(cause) === 'ENOENT') return
						throw cause
					}
				},
				list: async function* (listPrefix = '') {
					let names: string[]
					try {
						names = await fs.readdir(pathFor(listPrefix))
					} catch (cause) {
						if (getErrnoCode(cause) === 'ENOENT') return
						throw cause
					}
					for (const entryName of names) {
						const key = join(normalizeKey(listPrefix), entryName)
						const st = await fs.stat(pathFor(key))
						if (st.type === 'missing' || st.type === 'other') continue
						yield {
							key,
							kind: st.type === 'dir' || st.type === 'directory' ? 'directory' : 'file',
							size: st.size,
							updatedAt: st.mtimeMs === undefined ? undefined : new Date(st.mtimeMs),
						}
					}
				},
				stat: async (key) => {
					const st = await fs.stat(pathFor(key))
					if (st.type === 'missing' || st.type === 'other') return undefined
					return {
						key,
						kind: st.type === 'dir' || st.type === 'directory' ? 'directory' : 'file',
						size: st.size,
						updatedAt: st.mtimeMs === undefined ? undefined : new Date(st.mtimeMs),
					}
				},
			}
		},
		preflight: async (requirement) => {
			if (requirement?.durable && capability !== 'durable') {
				throw new PersistenceError(
					'UNAVAILABLE',
					`[PersistenceService] durable persistence required, but the configured workspace backend is ${capability}. Fix: pass a durable backend or remove the durable preflight requirement.`,
				)
			}
			if (requirement?.writable && capability === 'readonly') {
				throw new PersistenceError(
					'READONLY',
					'[PersistenceService] writable persistence required, but the configured workspace backend is readonly. Fix: pass a writable backend or remove the writable preflight requirement.',
				)
			}
			if (requirement?.writable) {
				const probe = root
					? join(root, `.pluxel-persistence-probe-${randomHex(4)}`)
					: `.pluxel-persistence-probe-${randomHex(4)}`
				await fs.writeTextAtomic(probe, '')
				await fs.unlink(probe)
			}
		},
	}
}

@RootService({ key: serviceName })
export class PersistenceService {
	private readonly backend: PersistenceBackend

	constructor(
		public ctx: PluxelContext,
		config?: PersistenceServiceConfig,
	) {
		this.backend = resolvePersistenceBackend(config)
	}

	get capability(): PersistenceCapability {
		return this.backend.capability
	}

	namespace(name: string): PersistenceNamespace {
		return this.backend.namespace(name)
	}

	preflight(requirement?: PersistenceRequirement): Promise<void> {
		return this.backend.preflight?.(requirement) ?? Promise.resolve()
	}
}

function resolvePersistenceBackend(
	config: PersistenceServiceConfig | undefined,
): PersistenceBackend {
	if (config === undefined) return createImplicitMemoryPersistenceBackend()

	if (typeof config === 'string') return createFilePersistenceBackend(config)
	if (!isRecord(config)) throw invalidPersistenceConfig()

	switch (config.mode) {
		case 'memory':
			return createMemoryPersistenceBackend()
		case 'custom':
			return assertPersistenceBackend(config.backend)
		case 'readonly': {
			const backend =
				'backend' in config
					? assertPersistenceBackend(config.backend)
					: createFilePersistenceBackend(String(config.dir ?? ''))
			return createReadonlyPersistenceBackend(backend)
		}
		default:
			throw invalidPersistenceConfig()
	}
}

function createFilePersistenceBackend(dir: string): PersistenceBackend {
	const root = dir.trim()
	if (!root) throw invalidPersistenceConfig()
	return createNodePersistenceBackend({ root })
}

function createImplicitMemoryPersistenceBackend(): PersistenceBackend {
	return createMemoryPersistenceBackend({
		warnOnWrite: (operation, namespace, key) => {
			const target = `${namespace}/${normalizeKey(key)}`
			console.warn(
				`[PersistenceService] implicit in-memory persistence received a ${operation} for "${target}". Data will be lost when the host restarts. Configure persistence: "./.pluxel/persistence" for Node file storage, pass persistence: { mode: "custom", backend } for custom storage, or set persistence: { mode: "memory" } if this is intentional.`,
			)
		},
	})
}

function assertPersistenceBackend(value: unknown): PersistenceBackend {
	if (
		isRecord(value) &&
		typeof value.capability === 'string' &&
		typeof value.namespace === 'function'
	) {
		return value as PersistenceBackend
	}
	throw invalidPersistenceConfig()
}

function invalidPersistenceConfig(): PersistenceError {
	return new PersistenceError(
		'UNAVAILABLE',
		'[PersistenceService] invalid persistence config. Use a string root path for Node file storage, { mode: "memory" } for ephemeral storage, { mode: "custom", backend } for custom storage, or { mode: "readonly", dir|backend } for readonly storage.',
	)
}
