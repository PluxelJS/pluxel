import { join, resolve } from 'pathe'

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

/** Relative slash-separated keys; empty/dot/parent segments and absolute paths are rejected. */
export type PersistenceNamespace = {
	get(key: string): Promise<Uint8Array | undefined>
	getText(key: string): Promise<string | undefined>
	put(key: string, value: Uint8Array | string, options?: { atomic?: boolean }): Promise<void>
	delete(key: string): Promise<void>
	/** Immediate children of a directory, sorted by key; omitted prefix selects the namespace root. */
	list(prefix?: string): AsyncIterable<PersistenceEntry>
	stat(key: string): Promise<PersistenceEntry | undefined>
}

export type PersistenceBackend = {
	capability: PersistenceCapability
	/** Literal relative namespace path; no lossy character replacement. */
	namespace(name: string): PersistenceNamespace
	preflight?(requirement?: PersistenceRequirement): Promise<void>
}

export type PersistenceServiceConfig =
	| string
	| { mode: 'memory' }
	| { mode: 'custom'; backend: PersistenceBackend }
	| ({ mode: 'readonly' } & ({ backend: PersistenceBackend } | { dir: string }))

export type WorkspacePersistenceBackendOptions = {
	/** Defaults to durable. Readonly rejects put and delete without requiring preflight. */
	capability?: PersistenceCapability
	/** Resolved once at creation; defaults to the current working directory. Not a symlink sandbox. */
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

// Paths are literal relative hierarchies, never repaired or silently aliased.
function validatePath(value: string, label: string, allowRoot = false): string {
	if (
		typeof value !== 'string' ||
		(!value && !allowRoot) ||
		// oxlint-disable-next-line no-control-regex -- Reject filesystem control characters at the input boundary.
		/[\\:\x00-\x1f\x7f]/.test(value) ||
		(value !== '' && value.split('/').some((part) => !part || part === '.' || part === '..'))
	) {
		throw new TypeError(
			`Persistence ${label} must be a relative slash-separated path without empty, dot or parent segments`,
		)
	}
	return value
}

function validateNamespace(name: string): string {
	return validatePath(name, 'namespace')
}
function validateKey(key: string): string {
	return validatePath(key, 'key')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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
	const directories = new Set<string>()
	const keyFor = (namespace: string, key: string) =>
		`${validateNamespace(namespace)}/${validateKey(key)}`
	let warned = false
	const warnOnWrite = (operation: 'put' | 'delete', namespace: string, key: string) => {
		if (warned || !options.warnOnWrite) return
		warned = true
		options.warnOnWrite(operation, namespace, key)
	}

	return {
		capability: 'ephemeral',
		namespace(name) {
			const namespace = validateNamespace(name)
			return {
				get: async (key) => {
					const fullKey = keyFor(namespace, key)
					if (directories.has(fullKey)) throw new PersistenceError('IO', 'Cannot read a directory')
					const value = data.get(fullKey)
					return value ? copyBytes(value) : undefined
				},
				getText: async (key) => {
					const fullKey = keyFor(namespace, key)
					if (directories.has(fullKey)) throw new PersistenceError('IO', 'Cannot read a directory')
					const value = data.get(fullKey)
					return value ? utf8Decode(value) : undefined
				},
				put: async (key, value) => {
					const fullKey = keyFor(namespace, key)
					if (directories.has(fullKey))
						throw new PersistenceError('IO', 'Cannot overwrite a directory')
					const parts = fullKey.split('/')
					const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
					if (parents.some((parent) => data.has(parent)))
						throw new PersistenceError('IO', 'Parent is a file')
					warnOnWrite('put', namespace, key)
					for (const parent of parents) directories.add(parent)
					data.set(fullKey, typeof value === 'string' ? utf8Encode(value) : copyBytes(value))
				},
				delete: async (key) => {
					const fullKey = keyFor(namespace, key)
					if (directories.has(fullKey))
						throw new PersistenceError('IO', 'Cannot delete a directory')
					warnOnWrite('delete', namespace, key)
					data.delete(fullKey)
				},
				list: async function* (prefix = '') {
					validatePath(prefix, 'list prefix', true)
					const base = prefix ? `${namespace}/${prefix}` : namespace
					if (data.has(base)) throw new PersistenceError('IO', 'Cannot list a file')
					for (const fullKey of [...directories, ...data.keys()].sort()) {
						if (!fullKey.startsWith(`${base}/`)) continue
						const child = fullKey.slice(base.length + 1)
						if (child.includes('/')) continue
						const key = prefix ? `${prefix}/${child}` : child
						const value = data.get(fullKey)
						if (!directories.has(fullKey) && !value) continue
						yield directories.has(fullKey)
							? { key, kind: 'directory' as const }
							: { key, kind: 'file' as const, size: value!.byteLength }
					}
				},
				stat: async (key) => {
					const fullKey = keyFor(namespace, key)
					if (directories.has(fullKey)) return { key, kind: 'directory' }
					const value = data.get(fullKey)
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
		task ??= import('../internal/workspace-fs')
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
	if (options.root === '') throw new TypeError('Persistence root must not be empty')
	const root = resolve(options.root ?? '.')
	const backend: PersistenceBackend = {
		capability,
		namespace(name) {
			const prefix = validateNamespace(name)
			const pathFor = (key: string, allowRoot = false) =>
				join(root, prefix, validatePath(key, 'key', allowRoot))
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
						names = await fs.readdir(pathFor(listPrefix, true))
					} catch (cause) {
						if (getErrnoCode(cause) === 'ENOENT') return
						throw cause
					}
					for (const entryName of names.sort()) {
						const key = join(validatePath(listPrefix, 'list prefix', true), entryName)
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

			if (requirement?.writable) {
				const probe = join(root, `.pluxel-persistence-probe-${randomHex(4)}`)
				await fs.writeTextAtomic(probe, '')
				await fs.unlink(probe)
			}
		},
	}
	return capability === 'readonly' ? createReadonlyPersistenceBackend(backend) : backend
}

export class PersistenceService {
	private readonly backend: PersistenceBackend

	constructor(config: PersistenceServiceConfig) {
		const backend = resolvePersistenceBackend(config)
		this.backend =
			backend.capability === 'readonly' ? createReadonlyPersistenceBackend(backend) : backend
	}

	get capability(): PersistenceCapability {
		return this.backend.capability
	}

	namespace(name: string): PersistenceNamespace {
		return this.backend.namespace(name)
	}

	async preflight(requirement?: PersistenceRequirement): Promise<void> {
		if (requirement?.durable && this.backend.capability !== 'durable') {
			throw new PersistenceError(
				'UNAVAILABLE',
				`[PersistenceService] durable persistence required, but the configured backend is ${this.backend.capability}.`,
			)
		}

		await this.backend.preflight?.(requirement)
	}
}

function resolvePersistenceBackend(config: PersistenceServiceConfig): PersistenceBackend {
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

function assertPersistenceBackend(value: unknown): PersistenceBackend {
	if (
		isRecord(value) &&
		['durable', 'ephemeral', 'readonly'].includes(value.capability as string) &&
		typeof value.namespace === 'function' &&
		(value.preflight === undefined || typeof value.preflight === 'function')
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
