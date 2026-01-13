import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { type Context, Injectable } from '@pluxel/context'
import { basename, dirname, resolve } from 'pathe'

const serviceName = 'fs' as const

declare module '@pluxel/context' {
	namespace Context {
		interface Config {
			[serviceName]?: FsServiceConfig
		}
		interface Services {
			[serviceName]: FsService
		}
	}
}

export type FsServiceMode = 'node' | 'memory'

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

type FsBackend = {
	exists: (path: string) => boolean
	readText: (path: string) => Promise<string>
	writeTextAtomic: (path: string, text: string) => Promise<void>
	readBytes: (path: string) => Promise<Uint8Array>
	writeBytesAtomic: (path: string, bytes: Uint8Array) => Promise<void>
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

async function renameReplaceNode(tmp: string, dst: string): Promise<void> {
	try {
		await rename(tmp, dst)
		return
	} catch (cause: unknown) {
		// Windows rename cannot replace existing file. Also seen as EPERM in some cases.
		const code = getErrnoCode(cause)
		if (code === 'EEXIST' || code === 'EPERM') {
			try {
				await rm(dst, { force: true })
			} catch {
				// ignore
			}
			await rename(tmp, dst)
			return
		}
		throw cause
	}
}

async function writeAtomicNode(path: string, data: Uint8Array | string): Promise<void> {
	const dir = dirname(path)
	await mkdir(dir, { recursive: true })
	const tmp = resolve(dir, `.tmp.${basename(path)}.${randomHex(8)}`)
	try {
		await writeFile(tmp, data, { mode: 0o600 })
		await renameReplaceNode(tmp, path)
	} catch (cause) {
		try {
			await rm(tmp, { force: true })
		} catch {
			// ignore
		}
		throw new FsError('IO', `Failed to write file: ${path}`, { cause })
	}
}

function createNodeBackend(): FsBackend {
	return {
		exists: (path) => existsSync(path),
		readText: async (path) => {
			try {
				return await readFile(path, 'utf8')
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT')
					throw new FsError('ENOENT', `Missing file: ${path}`, { cause })
				throw new FsError('IO', `Failed to read file: ${path}`, { cause })
			}
		},
		writeTextAtomic: (path, text) => writeAtomicNode(path, text),
		readBytes: async (path) => {
			try {
				return new Uint8Array(await readFile(path))
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT')
					throw new FsError('ENOENT', `Missing file: ${path}`, { cause })
				throw new FsError('IO', `Failed to read file: ${path}`, { cause })
			}
		},
		writeBytesAtomic: (path, bytes) => writeAtomicNode(path, bytes),
	}
}

function createMemoryBackend(): FsBackend {
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
 * Minimal fs service used by core services and plugins.
 *
 * Design goals:
 * - Keep the surface small and test-friendly (no Node fs API mirroring).
 * - Provide atomic writes for config/secrets/persistence files.
 * - Allow switching to an in-memory backend via config.
 *
 * Semantics:
 * - `write*Atomic` aims to be "atomic enough" on supported platforms (tmp + rename; with Windows replace fallback).
 * - In `memory` mode, `readBytes()` returns a copy to match "read from disk" immutability expectations.
 */
@Injectable({ key: serviceName, scope: 'root' })
export class FsService {
	private backend: FsBackend

	constructor(
		public ctx: Context,
		config: FsServiceConfig = {},
	) {
		const mode: FsServiceMode = config.mode ?? 'node'
		this.backend = mode === 'memory' ? createMemoryBackend() : createNodeBackend()
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
		return this.backend.debugStats?.() ?? { readText: 0, writeTextAtomic: 0, readBytes: 0, writeBytesAtomic: 0 }
	}
}

