import { existsSync } from 'node:fs'
import {
	copyFile,
	mkdir,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import { type Context, RootService } from '@pluxel/core'
import { basename, dirname, resolve } from 'pathe'

const serviceName = 'fs' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			[serviceName]?: FsServiceConfig
		}
		interface RootServices {
			[serviceName]: FsService
		}
	}
}

export type FsServiceMode = 'node' | 'memory'

export type FsServiceNodeBackendFs = {
	existsSync(path: string): boolean
	promises: {
		copyFile(src: string, dest: string): Promise<void>
		mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
		readFile(
			path: string,
			options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
		): Promise<string | Buffer>
		readdir(path: string, options?: { withFileTypes?: boolean }): Promise<string[]>
		realpath(path: string): Promise<string>
		rename(oldPath: string, newPath: string): Promise<void>
		rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>
		stat(path: string): Promise<{
			isFile(): boolean
			isDirectory(): boolean
			size?: number
			mtimeMs?: number
		}>
		writeFile(
			path: string,
			data: string | NodeJS.ArrayBufferView,
			options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number } | null,
		): Promise<void>
	}
}

export type FsServiceConfig = {
	/**
	 * Select fs backend.
	 *
	 * - `node`: use `node:fs` / `node:fs/promises`
	 * - `memory`: in-memory Map (for tests or fully ephemeral runs)
	 *
	 * @default "node"
	 */
	mode?: FsServiceMode
	/** Override the filesystem backend with a custom node-like implementation. */
	backend?: FsServiceBackend
}

export class FsError extends Error {
	public readonly code: 'ENOENT' | 'IO'
	constructor(code: FsError['code'], message: string, options?: { cause?: unknown }) {
		super(message)
		this.name = 'FsError'
		this.code = code
		if (options?.cause !== undefined) (this as unknown as { cause?: unknown }).cause = options.cause
	}
}

export type FsServiceStats = {
	readText: number
	writeTextAtomic: number
	readBytes: number
	writeBytesAtomic: number
}

export type FsEntryType = 'file' | 'dir' | 'other' | 'missing'

export type FsStat = {
	type: FsEntryType
	size?: number
	mtimeMs?: number
}

export type FsServiceBackend = {
	exists: (path: string) => boolean
	readText: (path: string) => Promise<string>
	writeTextAtomic: (path: string, text: string) => Promise<void>
	readBytes: (path: string) => Promise<Uint8Array>
	writeBytesAtomic: (path: string, bytes: Uint8Array) => Promise<void>
	unlink: (path: string) => Promise<void>
	rm: (path: string, options: { recursive?: boolean; force?: boolean }) => Promise<void>
	readdir: (path: string) => Promise<string[]>
	stat: (path: string) => Promise<FsStat>
	debugListFiles?: (prefix?: string) => string[]
	debugStats?: () => FsServiceStats
}

function utf8Encode(s: string): Uint8Array {
	return new TextEncoder().encode(s)
}

function utf8Decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

function bytesToHex(bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
	return out
}

function copyBytes(bytes: Uint8Array): Uint8Array {
	return bytes.slice()
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
	// Best-effort fallback (should be rare): unique tmp names, not cryptographic.
	return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2)
}

function getErrnoCode(error: unknown): unknown {
	if (!error || typeof error !== 'object') return undefined
	if (!('code' in error)) return undefined
	return (error as { code?: unknown }).code
}

async function renameReplaceNode(
	tmp: string,
	dst: string,
	fs: Pick<FsServiceNodeBackendFs['promises'], 'rename' | 'rm'>,
): Promise<void> {
	try {
		await fs.rename(tmp, dst)
		return
	} catch (cause: unknown) {
		// Windows rename cannot replace existing file. Also seen as EPERM in some cases.
		const code = getErrnoCode(cause)
		if (code === 'EEXIST' || code === 'EPERM') {
			try {
				await fs.rm(dst, { force: true })
			} catch {
				// ignore
			}
			await fs.rename(tmp, dst)
			return
		}
		throw cause
	}
}

async function writeAtomicNode(
	path: string,
	data: Uint8Array | string,
	fs: Pick<FsServiceNodeBackendFs, 'promises'>,
): Promise<void> {
	const dir = dirname(path)
	await fs.promises.mkdir(dir, { recursive: true })
	const tmp = resolve(dir, `.tmp.${basename(path)}.${randomHex(8)}`)
	try {
		await fs.promises.writeFile(tmp, data, { mode: 0o600 })
		await renameReplaceNode(tmp, path, fs.promises)
	} catch (cause) {
		try {
			await fs.promises.rm(tmp, { force: true })
		} catch {
			// ignore
		}
		throw new FsError('IO', `Failed to write file: ${path}`, { cause })
	}
}

const nodeBackendFs: FsServiceNodeBackendFs = {
	existsSync,
	promises: {
		copyFile,
		mkdir,
		readFile,
		readdir: readdir as FsServiceNodeBackendFs['promises']['readdir'],
		realpath,
		rename,
		rm,
		stat,
		writeFile,
	},
}

export function createNodeFsServiceBackend(
	fs: FsServiceNodeBackendFs = nodeBackendFs,
): FsServiceBackend {
	return {
		exists: (path) => fs.existsSync(path),
		readText: async (path) => {
			try {
				const content = await fs.promises.readFile(path, 'utf8')
				return typeof content === 'string' ? content : new TextDecoder().decode(content)
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT')
					throw new FsError('ENOENT', `Missing file: ${path}`, { cause })
				throw new FsError('IO', `Failed to read file: ${path}`, { cause })
			}
		},
		writeTextAtomic: (path, text) => writeAtomicNode(path, text, fs),
		readBytes: async (path) => {
			try {
				const content = await fs.promises.readFile(path)
				return typeof content === 'string' ? utf8Encode(content) : new Uint8Array(content)
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT')
					throw new FsError('ENOENT', `Missing file: ${path}`, { cause })
				throw new FsError('IO', `Failed to read file: ${path}`, { cause })
			}
		},
		writeBytesAtomic: (path, bytes) => writeAtomicNode(path, bytes, fs),
		unlink: async (path) => {
			try {
				await fs.promises.rm(path, { force: true })
			} catch (cause: unknown) {
				throw new FsError('IO', `Failed to unlink: ${path}`, { cause })
			}
		},
		rm: async (path, options) => {
			try {
				await fs.promises.rm(path, {
					recursive: options.recursive === true,
					force: options.force === true,
				})
			} catch (cause: unknown) {
				throw new FsError('IO', `Failed to rm: ${path}`, { cause })
			}
		},
		readdir: async (path) => {
			try {
				return (await fs.promises.readdir(path)) as string[]
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT') return []
				throw new FsError('IO', `Failed to readdir: ${path}`, { cause })
			}
		},
		stat: async (path) => {
			try {
				const st = await fs.promises.stat(path)
				const type: FsEntryType = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
				return { type, size: st.size, mtimeMs: st.mtimeMs }
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT') return { type: 'missing' }
				throw new FsError('IO', `Failed to stat: ${path}`, { cause })
			}
		},
	}
}

function createMemoryBackend(): FsServiceBackend {
	const files = new Map<string, Uint8Array>()
	const stats: FsServiceStats = {
		readText: 0,
		writeTextAtomic: 0,
		readBytes: 0,
		writeBytesAtomic: 0,
	}

	const ensure = (path: string): Uint8Array => {
		const data = files.get(path)
		if (!data) throw new FsError('ENOENT', `Missing file: ${path}`)
		return data
	}

	return {
		exists: (path) => files.has(path),
		readText: async (path) => {
			stats.readText++
			return utf8Decode(ensure(path))
		},
		writeTextAtomic: async (path, text) => {
			stats.writeTextAtomic++
			files.set(path, utf8Encode(text))
		},
		readBytes: async (path) => {
			stats.readBytes++
			return copyBytes(ensure(path))
		},
		writeBytesAtomic: async (path, bytes) => {
			stats.writeBytesAtomic++
			files.set(path, copyBytes(bytes))
		},
		unlink: async (path) => {
			files.delete(path)
		},
		rm: async (path, options) => {
			if (!options.recursive) {
				files.delete(path)
				return
			}
			const prefix = path.endsWith('/') ? path : `${path}/`
			for (const key of files.keys()) {
				if (key === path || key.startsWith(prefix)) files.delete(key)
			}
		},
		readdir: async (path) => {
			const prefix = path.endsWith('/') ? path : `${path}/`
			const names = new Set<string>()
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue
				const rest = key.slice(prefix.length)
				const first = rest.split('/')[0]
				if (first) names.add(first)
			}
			return [...names].sort()
		},
		stat: async (path) => {
			const data = files.get(path)
			if (!data) return { type: 'missing' }
			return { type: 'file', size: data.byteLength, mtimeMs: 0 }
		},
		debugListFiles: (prefix) => {
			const out: string[] = []
			for (const key of files.keys()) {
				if (!prefix || key.startsWith(prefix)) out.push(key)
			}
			out.sort()
			return out
		},
		debugStats: () => ({ ...stats }),
	}
}

/**
 * Minimal fs service used by runtime services and plugins.
 *
 * Design goals:
 * - Keep the surface small and test-friendly (no Node fs API mirroring).
 * - Provide atomic writes for config/secrets/persistence files.
 * - Allow switching to an in-memory backend via config.
 */
@RootService({ key: serviceName })
export class FsService {
	private backend: FsServiceBackend

	constructor(
		public ctx: Context,
		config: FsServiceConfig = {},
	) {
		const mode: FsServiceMode = config.mode ?? 'node'
		this.backend =
			config.backend ?? (mode === 'memory' ? createMemoryBackend() : createNodeFsServiceBackend())
	}

	/** Returns whether a path exists (file only in memory mode; file/dir in node mode). */
	exists(path: string): boolean {
		return this.backend.exists(path)
	}

	/** Reads a UTF-8 text file. Throws `FsError` with `code: "ENOENT"` when missing. */
	readText(path: string): Promise<string> {
		return this.backend.readText(path)
	}

	/** Atomically writes a UTF-8 text file (mkdirp + write temp + rename in node mode). */
	writeTextAtomic(path: string, text: string): Promise<void> {
		return this.backend.writeTextAtomic(path, text)
	}

	/** Reads bytes from a file. Throws `FsError` with `code: "ENOENT"` when missing. */
	readBytes(path: string): Promise<Uint8Array> {
		return this.backend.readBytes(path)
	}

	/** Atomically writes bytes to a file (mkdirp + write temp + rename in node mode). */
	writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
		return this.backend.writeBytesAtomic(path, bytes)
	}

	/** Best-effort unlink. In node mode this is "rm --force". */
	unlink(path: string): Promise<void> {
		return this.backend.unlink(path)
	}

	/**
	 * Removes a file or directory.
	 *
	 * - `recursive`: remove directory trees
	 * - `force`: ignore missing paths
	 */
	rm(path: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
		return this.backend.rm(path, options)
	}

	/** Lists immediate children names of a directory. Returns empty array when missing. */
	readdir(path: string): Promise<string[]> {
		return this.backend.readdir(path)
	}

	/** Minimal stat that is stable across backends. */
	stat(path: string): Promise<FsStat> {
		return this.backend.stat(path)
	}

	/**
	 * Debug helper (stable enough for tests).
	 *
	 * - In memory mode: returns stored file paths.
	 * - In node mode: returns empty array.
	 */
	debugListFiles(prefix?: string): string[] {
		return this.backend.debugListFiles?.(prefix) ?? []
	}

	/** Debug helper for tests. */
	debugStats(): FsServiceStats {
		return (
			this.backend.debugStats?.() ?? {
				readText: 0,
				writeTextAtomic: 0,
				readBytes: 0,
				writeBytesAtomic: 0,
			}
		)
	}
}
