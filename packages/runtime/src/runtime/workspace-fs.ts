import { existsSync, readFileSync } from 'node:fs'
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
import { basename, dirname, resolve } from 'pathe'

export type NodeWorkspaceFs = {
	existsSync(path: string): boolean
	readFileSync(
		path: string,
		options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
	): string | Buffer
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

export class WorkspaceFsError extends Error {
	public readonly code: 'ENOENT' | 'IO'
	constructor(code: WorkspaceFsError['code'], message: string, options?: { cause?: unknown }) {
		super(message)
		this.name = 'WorkspaceFsError'
		this.code = code
		if (options?.cause !== undefined) (this as unknown as { cause?: unknown }).cause = options.cause
	}
}

export type WorkspaceFsEntryType = 'file' | 'dir' | 'other' | 'missing'

export type WorkspaceFsStat = {
	type: WorkspaceFsEntryType
	size?: number
	mtimeMs?: number
}

export type WorkspaceFsBackend = {
	exists(path: string): boolean
	readTextSync(path: string): string
	readText(path: string): Promise<string>
	writeTextAtomic(path: string, text: string): Promise<void>
	readBytes(path: string): Promise<Uint8Array>
	writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void>
	unlink(path: string): Promise<void>
	rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>
	readdir(path: string): Promise<string[]>
	stat(path: string): Promise<WorkspaceFsStat>
}

function utf8Encode(s: string): Uint8Array {
	return new TextEncoder().encode(s)
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

function getErrnoCode(error: unknown): unknown {
	if (!error || typeof error !== 'object') return undefined
	if (!('code' in error)) return undefined
	return (error as { code?: unknown }).code
}

async function renameReplaceNode(
	tmp: string,
	dst: string,
	fs: Pick<NodeWorkspaceFs['promises'], 'rename' | 'rm'>,
): Promise<void> {
	try {
		await fs.rename(tmp, dst)
		return
	} catch (cause: unknown) {
		const code = getErrnoCode(cause)
		if (code === 'EEXIST' || code === 'EPERM') {
			await fs.rm(dst, { force: true }).catch((): void => undefined)
			await fs.rename(tmp, dst)
			return
		}
		throw cause
	}
}

async function writeAtomicNode(
	path: string,
	data: Uint8Array | string,
	fs: Pick<NodeWorkspaceFs, 'promises'>,
): Promise<void> {
	const dir = dirname(path)
	await fs.promises.mkdir(dir, { recursive: true })
	const tmp = resolve(dir, `.tmp.${basename(path)}.${randomHex(8)}`)
	try {
		await fs.promises.writeFile(tmp, data, { mode: 0o600 })
		await renameReplaceNode(tmp, path, fs.promises)
	} catch (cause) {
		await fs.promises.rm(tmp, { force: true }).catch((): void => undefined)
		throw new WorkspaceFsError('IO', `Failed to write file: ${path}`, { cause })
	}
}

const nodeBackendFs: NodeWorkspaceFs = {
	existsSync,
	readFileSync,
	promises: {
		copyFile,
		mkdir,
		readFile,
		readdir: readdir as NodeWorkspaceFs['promises']['readdir'],
		realpath,
		rename,
		rm,
		stat,
		writeFile,
	},
}

export function createNodeWorkspaceFsBackend(
	fs: NodeWorkspaceFs = nodeBackendFs,
): WorkspaceFsBackend {
	return {
		exists: (path) => fs.existsSync(path),
		readTextSync: (path) => {
			try {
				const content = fs.readFileSync(path, 'utf8')
				return typeof content === 'string' ? content : new TextDecoder().decode(content)
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT')
					throw new WorkspaceFsError('ENOENT', `Missing file: ${path}`, { cause })
				throw new WorkspaceFsError('IO', `Failed to read file: ${path}`, { cause })
			}
		},
		readText: async (path) => {
			try {
				const content = await fs.promises.readFile(path, 'utf8')
				return typeof content === 'string' ? content : new TextDecoder().decode(content)
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT')
					throw new WorkspaceFsError('ENOENT', `Missing file: ${path}`, { cause })
				throw new WorkspaceFsError('IO', `Failed to read file: ${path}`, { cause })
			}
		},
		writeTextAtomic: (path, text) => writeAtomicNode(path, text, fs),
		readBytes: async (path) => {
			try {
				const content = await fs.promises.readFile(path)
				return typeof content === 'string' ? utf8Encode(content) : new Uint8Array(content)
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT')
					throw new WorkspaceFsError('ENOENT', `Missing file: ${path}`, { cause })
				throw new WorkspaceFsError('IO', `Failed to read file: ${path}`, { cause })
			}
		},
		writeBytesAtomic: (path, bytes) => writeAtomicNode(path, bytes, fs),
		unlink: async (path) => {
			try {
				await fs.promises.rm(path, { force: true })
			} catch (cause: unknown) {
				throw new WorkspaceFsError('IO', `Failed to unlink: ${path}`, { cause })
			}
		},
		rm: async (path, options) => {
			try {
				await fs.promises.rm(path, {
					recursive: options.recursive === true,
					force: options.force === true,
				})
			} catch (cause: unknown) {
				throw new WorkspaceFsError('IO', `Failed to rm: ${path}`, { cause })
			}
		},
		readdir: async (path) => {
			try {
				return (await fs.promises.readdir(path)) as string[]
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT') return []
				throw new WorkspaceFsError('IO', `Failed to readdir: ${path}`, { cause })
			}
		},
		stat: async (path) => {
			try {
				const st = await fs.promises.stat(path)
				const type: WorkspaceFsEntryType = st.isFile()
					? 'file'
					: st.isDirectory()
						? 'dir'
						: 'other'
				return { type, size: st.size, mtimeMs: st.mtimeMs }
			} catch (cause: unknown) {
				if (getErrnoCode(cause) === 'ENOENT') return { type: 'missing' }
				throw new WorkspaceFsError('IO', `Failed to stat: ${path}`, { cause })
			}
		},
	}
}
