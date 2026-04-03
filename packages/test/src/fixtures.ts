import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import {
	createFixture as createRawFixture,
	type CreateFixtureOptions,
	type FileTree,
	type FsFixture,
} from 'fs-fixture'
import { create, MemoryProvider, type VirtualFileSystem } from '@platformatic/vfs'

const require = createRequire(import.meta.url)
const realFs = require('node:fs') as typeof import('node:fs')
const realFsPromises = require('node:fs/promises') as typeof import('node:fs/promises')
const realOs = require('node:os') as typeof import('node:os')

type PathLike = string | URL | Buffer
type CopyOptions = { recursive?: boolean; force?: boolean }
type RmOptions = { recursive?: boolean; force?: boolean }
type RmdirOptions = { recursive?: boolean }
type NamedEntry = string | { name: string }
type SupportedDirEntry = {
	name: string
	isDirectory?: () => boolean
	isFile?: () => boolean
	isSymbolicLink?: () => boolean
}
type SupportedStats = {
	isDirectory?: () => boolean
	isFile?: () => boolean
	isSymbolicLink?: () => boolean
	size?: number
	mtimeMs?: number
}

type FixtureMode = 'memory' | 'disk'

type VirtualFixtureState = {
	root: string
	vfs: VirtualFileSystem
}

type SupportedFsPromises = {
	access(path: PathLike, mode?: number): Promise<void>
	appendFile(
		path: PathLike,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
	): Promise<void>
	copyFile(source: PathLike, destination: PathLike): Promise<void>
	cp(source: PathLike, destination: PathLike, options?: CopyOptions): Promise<void>
	lstat(path: PathLike, options?: { bigint?: boolean }): Promise<SupportedStats>
	mkdir(path: PathLike, options?: { recursive?: boolean }): Promise<string | undefined>
	mkdtemp(prefix: string): Promise<string>
	readFile(
		path: PathLike,
		options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
	): Promise<string | Buffer>
	readdir: {
		(path: PathLike, options: { withFileTypes: true }): Promise<SupportedDirEntry[]>
		(path: PathLike, options?: { withFileTypes?: false }): Promise<string[]>
	}
	readlink(path: PathLike, options?: { encoding?: BufferEncoding }): Promise<string>
	realpath(path: PathLike, options?: { encoding?: BufferEncoding }): Promise<string>
	rename(source: PathLike, destination: PathLike): Promise<void>
	rm(path: PathLike, options?: RmOptions): Promise<void>
	rmdir(path: PathLike, options?: RmdirOptions): Promise<void>
	stat(path: PathLike, options?: { bigint?: boolean }): Promise<SupportedStats>
	symlink(target: string, path: PathLike, type?: string): Promise<void>
	unlink(path: PathLike): Promise<void>
	writeFile(
		path: PathLike,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number } | null,
	): Promise<void>
}

type SupportedFs = {
	access(
		path: PathLike,
		mode: number | ((error: NodeJS.ErrnoException | null) => void),
		callback?: (error: NodeJS.ErrnoException | null) => void,
	): void
	accessSync(path: PathLike, mode?: number): void
	appendFile(
		path: PathLike,
		data: string | NodeJS.ArrayBufferView,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null) => void,
	): void
	appendFileSync(
		path: PathLike,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
	): void
	copyFile(
		source: PathLike,
		destination: PathLike,
		callback: (error: NodeJS.ErrnoException | null) => void,
	): void
	copyFileSync(source: PathLike, destination: PathLike): void
	cp(
		source: PathLike,
		destination: PathLike,
		options: CopyOptions | ((error: NodeJS.ErrnoException | null) => void),
		callback?: (error: NodeJS.ErrnoException | null) => void,
	): void
	cpSync(source: PathLike, destination: PathLike, options?: CopyOptions): void
	createReadStream(
		path: PathLike,
		options?: Parameters<typeof realFs.createReadStream>[1],
	): ReturnType<typeof realFs.createReadStream>
	createWriteStream(
		path: PathLike,
		options?: Parameters<typeof realFs.createWriteStream>[1],
	): ReturnType<typeof realFs.createWriteStream>
	existsSync(path: PathLike): boolean
	lstat(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null, stats?: SupportedStats) => void,
	): void
	lstatSync(
		path: PathLike,
		options?: { bigint?: boolean; throwIfNoEntry?: boolean },
	): SupportedStats | undefined
	mkdir(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null, createdPath?: string) => void,
	): void
	mkdirSync(path: PathLike, options?: { recursive?: boolean }): string | undefined
	mkdtemp(
		prefix: string,
		callback: (error: NodeJS.ErrnoException | null, directory?: string) => void,
	): void
	mkdtempSync(prefix: string): string
	promises: SupportedFsPromises
	readFile(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null, data?: string | Buffer) => void,
	): void
	readFileSync(
		path: PathLike,
		options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
	): string | Buffer
	readdir(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null, entries?: string[] | SupportedDirEntry[]) => void,
	): void
	readdirSync(path: PathLike, options: { withFileTypes: true }): SupportedDirEntry[]
	readdirSync(path: PathLike, options?: { withFileTypes?: false }): string[]
	readlink(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null, linkString?: string) => void,
	): void
	readlinkSync(path: PathLike, options?: { encoding?: BufferEncoding }): string
	realpath(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null, resolvedPath?: string) => void,
	): void
	realpathSync(path: PathLike, options?: { encoding?: BufferEncoding }): string
	rename(
		source: PathLike,
		destination: PathLike,
		callback: (error: NodeJS.ErrnoException | null) => void,
	): void
	renameSync(source: PathLike, destination: PathLike): void
	rm(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null) => void,
	): void
	rmSync(path: PathLike, options?: RmOptions): void
	rmdir(
		path: PathLike,
		options: RmdirOptions | ((error: NodeJS.ErrnoException | null) => void),
		callback?: (error: NodeJS.ErrnoException | null) => void,
	): void
	rmdirSync(path: PathLike): void
	stat(
		path: PathLike,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null, stats?: SupportedStats) => void,
	): void
	statSync(
		path: PathLike,
		options?: { bigint?: boolean; throwIfNoEntry?: boolean },
	): SupportedStats | undefined
	symlink(
		target: string,
		path: PathLike,
		type: unknown,
		callback?: (error: NodeJS.ErrnoException | null) => void,
	): void
	symlinkSync(target: string, path: PathLike, type?: string): void
	unlink(path: PathLike, callback: (error: NodeJS.ErrnoException | null) => void): void
	unlinkSync(path: PathLike): void
	writeFile(
		path: PathLike,
		data: string | NodeJS.ArrayBufferView,
		options: unknown,
		callback?: (error: NodeJS.ErrnoException | null) => void,
	): void
	writeFileSync(
		path: PathLike,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
	): void
}

type FixtureFsApi = {
	mode: FixtureMode
	root: string
	fs: SupportedFs
	fsp: SupportedFsPromises
	tmpdir(): string
	vfs?: VirtualFileSystem
}

export type TestFixture = FsFixture & FixtureFsApi

function randomSuffix(): string {
	if (typeof randomUUID === 'function') return randomUUID()
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createMemoryState(): VirtualFixtureState {
	return {
		root: resolve(realOs.tmpdir(), 'pluxel-vitest-vfs', `${process.pid}-${randomSuffix()}`),
		vfs: create(new MemoryProvider(), { moduleHooks: false }),
	}
}

function toPath(path: PathLike): string {
	if (Buffer.isBuffer(path)) return path.toString()
	return path instanceof URL ? fileURLToPath(path) : path
}

function normalizeData(data: string | NodeJS.ArrayBufferView): string | Buffer {
	if (typeof data === 'string' || Buffer.isBuffer(data)) return data
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function entryName(entry: NamedEntry): string {
	return typeof entry === 'string' ? entry : entry.name
}

function isEnoent(error: unknown): boolean {
	return (
		Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
	)
}

function createFsError(
	code: 'ENOENT' | 'ENOTDIR',
	path: string,
	syscall: 'open',
): NodeJS.ErrnoException {
	const action = code === 'ENOENT' ? 'no such file or directory' : 'not a directory'
	return Object.assign(new Error(`${code}: ${action}, ${syscall} '${path}'`), {
		code,
		errno: code === 'ENOENT' ? -2 : -20,
		path,
		syscall,
	}) as NodeJS.ErrnoException
}

function callbackify<T>(
	run: () => Promise<T>,
	callback: (error: NodeJS.ErrnoException | null, value?: T) => void,
) {
	run().then(
		(value) => callback(null, value),
		(error: NodeJS.ErrnoException) => callback(error),
	)
}

function createVirtualRuntime(state: VirtualFixtureState): FixtureFsApi {
	function isVirtualPath(path: PathLike): boolean {
		const abs = resolve(toPath(path))
		return abs === state.root || abs.startsWith(`${state.root}${sep}`)
	}

	function ensureSameWorld(source: PathLike, destination: PathLike) {
		const sourceVirtual = isVirtualPath(source)
		const destinationVirtual = isVirtualPath(destination)
		return { sourceVirtual, destinationVirtual }
	}

	async function ensureVirtualWriteParent(path: string): Promise<void> {
		const parent = dirname(path)
		try {
			const stats = await state.vfs.promises.stat(parent)
			if (!stats.isDirectory()) throw createFsError('ENOTDIR', path, 'open')
		} catch (error) {
			if (isEnoent(error)) throw createFsError('ENOENT', path, 'open')
			throw error
		}
	}

	function ensureVirtualWriteParentSync(path: string): void {
		const parent = dirname(path)
		try {
			const stats = state.vfs.statSync(parent)
			if (!stats.isDirectory()) throw createFsError('ENOTDIR', path, 'open')
		} catch (error) {
			if (isEnoent(error)) throw createFsError('ENOENT', path, 'open')
			throw error
		}
	}

	async function mkdirAny(
		path: string,
		options: { recursive?: boolean } = {},
	): Promise<string | undefined> {
		if (isVirtualPath(path)) return await state.vfs.promises.mkdir(path, options)
		return await realFsPromises.mkdir(path, options)
	}

	function mkdirAnySync(
		path: string,
		options: { recursive?: boolean } = {},
	): string | undefined {
		if (isVirtualPath(path)) return state.vfs.mkdirSync(path, options)
		return realFs.mkdirSync(path, options)
	}

	async function lstatAny(path: string) {
		if (isVirtualPath(path)) return await state.vfs.promises.lstat(path)
		return await realFsPromises.lstat(path)
	}

	function lstatAnySync(path: string) {
		if (isVirtualPath(path)) return state.vfs.lstatSync(path)
		return realFs.lstatSync(path)
	}

	async function readdirAny(path: string, options?: { withFileTypes?: boolean }) {
		if (isVirtualPath(path)) return await state.vfs.promises.readdir(path, options as never)
		return await realFsPromises.readdir(path, options as never)
	}

	function readdirAnySync(path: string, options?: { withFileTypes?: boolean }) {
		if (isVirtualPath(path)) return state.vfs.readdirSync(path, options as never)
		return realFs.readdirSync(path, options as never)
	}

	async function unlinkAny(path: string): Promise<void> {
		if (isVirtualPath(path)) return await state.vfs.promises.unlink(path)
		return await realFsPromises.unlink(path)
	}

	function unlinkAnySync(path: string): void {
		if (isVirtualPath(path)) {
			state.vfs.unlinkSync(path)
			return
		}
		realFs.unlinkSync(path)
	}

	async function rmdirAny(path: string, options: RmdirOptions = {}): Promise<void> {
		if (options.recursive) {
			await rmAny(path, { recursive: true })
			return
		}
		if (isVirtualPath(path)) return await state.vfs.promises.rmdir(path)
		return await realFsPromises.rmdir(path)
	}

	function rmdirAnySync(path: string): void {
		if (isVirtualPath(path)) {
			state.vfs.rmdirSync(path)
			return
		}
		realFs.rmdirSync(path)
	}

	async function readFileRaw(path: string): Promise<Buffer> {
		if (isVirtualPath(path)) return await state.vfs.promises.readFile(path)
		return await realFsPromises.readFile(path)
	}

	function readFileRawSync(path: string): Buffer {
		if (isVirtualPath(path)) return state.vfs.readFileSync(path)
		return realFs.readFileSync(path)
	}

	async function writeFileRaw(
		path: string,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number } | null,
	): Promise<void> {
		const nextData = normalizeData(data)
		if (isVirtualPath(path)) {
			await ensureVirtualWriteParent(path)
			return await state.vfs.promises.writeFile(path, nextData, options as never)
		}
		return await realFsPromises.writeFile(path, nextData, options as never)
	}

	function writeFileRawSync(
		path: string,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
	): void {
		const nextData = normalizeData(data)
		if (isVirtualPath(path)) {
			ensureVirtualWriteParentSync(path)
			state.vfs.writeFileSync(path, nextData, options as never)
			return
		}
		realFs.writeFileSync(path, nextData, options as never)
	}

	async function appendFileRaw(
		path: string,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
	): Promise<void> {
		const nextData = normalizeData(data)
		if (isVirtualPath(path)) {
			await ensureVirtualWriteParent(path)
			return await state.vfs.promises.appendFile(path, nextData, options as never)
		}
		return await realFsPromises.appendFile(path, nextData, options as never)
	}

	function appendFileRawSync(
		path: string,
		data: string | NodeJS.ArrayBufferView,
		options?: BufferEncoding | { encoding?: BufferEncoding; mode?: number },
	): void {
		const nextData = normalizeData(data)
		if (isVirtualPath(path)) {
			ensureVirtualWriteParentSync(path)
			state.vfs.appendFileSync(path, nextData, options as never)
			return
		}
		realFs.appendFileSync(path, nextData, options as never)
	}

	async function readlinkAny(path: string): Promise<string> {
		if (isVirtualPath(path)) return await state.vfs.promises.readlink(path)
		return await realFsPromises.readlink(path)
	}

	function readlinkAnySync(path: string): string {
		if (isVirtualPath(path)) return state.vfs.readlinkSync(path)
		return realFs.readlinkSync(path)
	}

	async function copyAny(
		source: string,
		destination: string,
		options: CopyOptions = {},
	): Promise<void> {
		const sourceStat = await lstatAny(source)
		if (sourceStat.isSymbolicLink()) {
			await mkdirAny(dirname(destination), { recursive: true })
			await symlinkAny(await readlinkAny(source), destination)
			return
		}
		if (sourceStat.isDirectory()) {
			if (!options.recursive)
				throw new Error(`cp() requires recursive=true for directories: ${source}`)
			await mkdirAny(destination, { recursive: true })
			const entries = await readdirAny(source, { withFileTypes: true })
			for (const entry of entries as NamedEntry[]) {
				await copyAny(join(source, entryName(entry)), join(destination, entryName(entry)), options)
			}
			return
		}
		const data = await readFileRaw(source)
		await mkdirAny(dirname(destination), { recursive: true })
		await writeFileRaw(destination, data)
	}

	function copyAnySync(source: string, destination: string, options: CopyOptions = {}): void {
		const sourceStat = lstatAnySync(source)
		if (sourceStat.isSymbolicLink()) {
			mkdirAnySync(dirname(destination), { recursive: true })
			symlinkAnySync(readlinkAnySync(source), destination)
			return
		}
		if (sourceStat.isDirectory()) {
			if (!options.recursive)
				throw new Error(`cp() requires recursive=true for directories: ${source}`)
			mkdirAnySync(destination, { recursive: true })
			const entries = readdirAnySync(source, { withFileTypes: true })
			for (const entry of entries as NamedEntry[]) {
				copyAnySync(join(source, entryName(entry)), join(destination, entryName(entry)), options)
			}
			return
		}
		const data = readFileRawSync(source)
		mkdirAnySync(dirname(destination), { recursive: true })
		writeFileRawSync(destination, data)
	}

	async function rmAny(path: string, options: RmOptions = {}): Promise<void> {
		try {
			const stats = await lstatAny(path)
			if (stats.isDirectory() && !stats.isSymbolicLink()) {
				if (options.recursive) {
					const entries = await readdirAny(path, { withFileTypes: true })
					for (const entry of entries as NamedEntry[]) {
						await rmAny(join(path, entryName(entry)), options)
					}
				}
				await rmdirAny(path)
				return
			}
			await unlinkAny(path)
		} catch (error) {
			if (options.force && isEnoent(error)) return
			throw error
		}
	}

	function rmAnySync(path: string, options: RmOptions = {}): void {
		try {
			const stats = lstatAnySync(path)
			if (stats.isDirectory() && !stats.isSymbolicLink()) {
				if (options.recursive) {
					const entries = readdirAnySync(path, { withFileTypes: true })
					for (const entry of entries as NamedEntry[]) {
						rmAnySync(join(path, entryName(entry)), options)
					}
				}
				rmdirAnySync(path)
				return
			}
			unlinkAnySync(path)
		} catch (error) {
			if (options.force && isEnoent(error)) return
			throw error
		}
	}

	async function renameAny(source: string, destination: string): Promise<void> {
		const { sourceVirtual, destinationVirtual } = ensureSameWorld(source, destination)
		if (sourceVirtual === destinationVirtual) {
			await mkdirAny(dirname(destination), { recursive: true })
			if (sourceVirtual) return await state.vfs.promises.rename(source, destination)
			return await realFsPromises.rename(source, destination)
		}
		await copyAny(source, destination, { recursive: true, force: true })
		await rmAny(source, { recursive: true, force: true })
	}

	function renameAnySync(source: string, destination: string): void {
		const { sourceVirtual, destinationVirtual } = ensureSameWorld(source, destination)
		if (sourceVirtual === destinationVirtual) {
			mkdirAnySync(dirname(destination), { recursive: true })
			if (sourceVirtual) {
				state.vfs.renameSync(source, destination)
				return
			}
			realFs.renameSync(source, destination)
			return
		}
		copyAnySync(source, destination, { recursive: true, force: true })
		rmAnySync(source, { recursive: true, force: true })
	}

	async function symlinkAny(target: string, path: string, type?: string): Promise<void> {
		await mkdirAny(dirname(path), { recursive: true })
		if (isVirtualPath(path)) return await state.vfs.promises.symlink(target, path, type)
		return await realFsPromises.symlink(target, path, type as never)
	}

	function symlinkAnySync(target: string, path: string, type?: string): void {
		mkdirAnySync(dirname(path), { recursive: true })
		if (isVirtualPath(path)) {
			state.vfs.symlinkSync(target, path, type)
			return
		}
		realFs.symlinkSync(target, path, type as never)
	}

	function mkdtempPath(prefix: string): string {
		return `${prefix}${randomSuffix()}`
	}

	const fsp: SupportedFsPromises = {
		...realFsPromises,
		access(path: PathLike, mode?: number) {
			if (isVirtualPath(path)) return state.vfs.promises.access(toPath(path), mode)
			return realFsPromises.access(path, mode)
		},
		appendFile(path: PathLike, data, options) {
			return appendFileRaw(toPath(path), data, options)
		},
		copyFile(source: PathLike, destination: PathLike) {
			return copyAny(toPath(source), toPath(destination))
		},
		cp(source: PathLike, destination: PathLike, options?: CopyOptions) {
			return copyAny(toPath(source), toPath(destination), options)
		},
		lstat: ((path: PathLike, options?: { bigint?: boolean }) => {
			if (isVirtualPath(path)) return state.vfs.promises.lstat(toPath(path), options)
			return realFsPromises.lstat(path, options)
		}) as SupportedFsPromises['lstat'],
		mkdir(path: PathLike, options?: { recursive?: boolean }) {
			return mkdirAny(toPath(path), options)
		},
		async mkdtemp(prefix: string) {
			if (!isVirtualPath(prefix)) return await realFsPromises.mkdtemp(prefix)
			const dir = mkdtempPath(prefix)
			await mkdirAny(dir, { recursive: true })
			return dir
		},
		readFile(path: PathLike, options?: BufferEncoding | { encoding?: BufferEncoding | null } | null) {
			if (isVirtualPath(path)) return state.vfs.promises.readFile(toPath(path), options as never)
			return realFsPromises.readFile(path, options as never)
		},
		readdir: ((path: PathLike, options?: { withFileTypes?: boolean }) => {
			return readdirAny(toPath(path), options)
		}) as SupportedFsPromises['readdir'],
		readlink(path: PathLike, options?: { encoding?: BufferEncoding }) {
			if (isVirtualPath(path)) return state.vfs.promises.readlink(toPath(path), options)
			return realFsPromises.readlink(path, options)
		},
		realpath(path: PathLike, options?: { encoding?: BufferEncoding }) {
			if (isVirtualPath(path)) return state.vfs.promises.realpath(toPath(path), options)
			return realFsPromises.realpath(path, options)
		},
		rename(source: PathLike, destination: PathLike) {
			return renameAny(toPath(source), toPath(destination))
		},
		rm(path: PathLike, options?: RmOptions) {
			return rmAny(toPath(path), options)
		},
		rmdir(path: PathLike, options?: RmdirOptions) {
			return rmdirAny(toPath(path), options)
		},
		stat: ((path: PathLike, options?: { bigint?: boolean }) => {
			if (isVirtualPath(path)) return state.vfs.promises.stat(toPath(path), options)
			return realFsPromises.stat(path, options)
		}) as SupportedFsPromises['stat'],
		symlink(target: string, path: PathLike, type?: string) {
			return symlinkAny(target, toPath(path), type)
		},
		unlink(path: PathLike) {
			return unlinkAny(toPath(path))
		},
		writeFile(path: PathLike, data, options) {
			return writeFileRaw(toPath(path), data, options)
		},
	}

	const fs: SupportedFs = {
		...realFs,
		access(path: PathLike, mode: any, callback?: (error: NodeJS.ErrnoException | null) => void) {
			const resolvedCallback = typeof mode === 'function' ? mode : callback
			const resolvedMode = typeof mode === 'function' ? undefined : mode
			if (!resolvedCallback) return
			callbackify(() => fsp.access(path, resolvedMode), resolvedCallback)
		},
		accessSync(path: PathLike, mode?: number) {
			if (isVirtualPath(path)) return state.vfs.accessSync(toPath(path), mode)
			return realFs.accessSync(path, mode)
		},
		appendFile(path: PathLike, data, options: any, callback?: (error: NodeJS.ErrnoException | null) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.appendFile(path, normalizeData(data), resolvedOptions), resolvedCallback)
		},
		appendFileSync(path: PathLike, data, options?) {
			return appendFileRawSync(toPath(path), data, options)
		},
		copyFile(source: PathLike, destination: PathLike, callback) {
			callbackify(() => fsp.copyFile(source, destination), callback)
		},
		cp(source: PathLike, destination: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.cp(source, destination, resolvedOptions), resolvedCallback)
		},
		cpSync(source: PathLike, destination: PathLike, options?: CopyOptions) {
			return copyAnySync(toPath(source), toPath(destination), options)
		},
		copyFileSync(source: PathLike, destination: PathLike) {
			return copyAnySync(toPath(source), toPath(destination))
		},
		createReadStream(path: PathLike, options?: Parameters<typeof realFs.createReadStream>[1]) {
			if (isVirtualPath(path)) {
				return state.vfs.createReadStream(toPath(path), options as never) as ReturnType<
					typeof realFs.createReadStream
				>
			}
			return realFs.createReadStream(path, options)
		},
		createWriteStream(path: PathLike, options?: Parameters<typeof realFs.createWriteStream>[1]) {
			if (!isVirtualPath(path)) return realFs.createWriteStream(path, options)
			const targetPath = toPath(path)
			const chunks: Buffer[] = []
			const streamOptions = typeof options === 'object' && options !== null ? options : {}
			const flags = streamOptions.flags ?? 'w'
			const encoding = streamOptions.encoding ?? 'utf8'
			return new Writable({
				write(chunk, chunkEncoding, callback) {
					const nextEncoding: BufferEncoding = Buffer.isBuffer(chunk)
						? (encoding as BufferEncoding)
						: chunkEncoding
					chunks.push(
						Buffer.isBuffer(chunk)
							? chunk
							: Buffer.from(chunk as string, nextEncoding as BufferEncoding),
					)
					callback()
				},
				final(callback) {
					const data = Buffer.concat(chunks)
					;(flags.includes('a')
						? appendFileRaw(targetPath, data, { encoding })
						: writeFileRaw(targetPath, data, { encoding })
					).then(
						() => callback(),
						(error: NodeJS.ErrnoException) => callback(error),
					)
				},
			}) as ReturnType<typeof realFs.createWriteStream>
		},
		existsSync(path: PathLike) {
			if (isVirtualPath(path)) return state.vfs.existsSync(toPath(path))
			return realFs.existsSync(path)
		},
		lstat(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null, stats?: SupportedStats) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.lstat(path, resolvedOptions), resolvedCallback as never)
		},
		lstatSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }) {
			try {
				if (isVirtualPath(path)) return state.vfs.lstatSync(toPath(path), options)
				return realFs.lstatSync(path, options as never)
			} catch (error) {
				if (options?.throwIfNoEntry === false && isEnoent(error)) return undefined
				throw error
			}
		},
		mkdir(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null, createdPath?: string) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.mkdir(path, resolvedOptions), resolvedCallback as never)
		},
		mkdirSync(path: PathLike, options?: { recursive?: boolean }) {
			return mkdirAnySync(toPath(path), options)
		},
		mkdtemp(prefix: string, callback) {
			callbackify(() => fsp.mkdtemp(prefix), callback as never)
		},
		mkdtempSync(prefix: string) {
			if (!isVirtualPath(prefix)) return realFs.mkdtempSync(prefix)
			const dir = mkdtempPath(prefix)
			mkdirAnySync(dir, { recursive: true })
			return dir
		},
		promises: fsp,
		readFile(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null, data?: string | Buffer) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.readFile(path, resolvedOptions), resolvedCallback as never)
		},
		readFileSync(path: PathLike, options?: BufferEncoding | { encoding?: BufferEncoding | null } | null) {
			if (isVirtualPath(path)) return state.vfs.readFileSync(toPath(path), options as never)
			return realFs.readFileSync(path, options as never)
		},
		readdir(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null, entries?: string[] | SupportedDirEntry[]) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.readdir(path, resolvedOptions), resolvedCallback as never)
		},
		readdirSync: ((path: PathLike, options?: { withFileTypes?: boolean }) => {
			return readdirAnySync(toPath(path), options)
		}) as SupportedFs['readdirSync'],
		readlink(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null, linkString?: string) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.readlink(path, resolvedOptions), resolvedCallback as never)
		},
		readlinkSync(path: PathLike, options?: { encoding?: BufferEncoding }) {
			if (isVirtualPath(path)) return state.vfs.readlinkSync(toPath(path), options)
			return realFs.readlinkSync(path, options)
		},
		realpath(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null, resolvedPath?: string) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.realpath(path, resolvedOptions), resolvedCallback as never)
		},
		realpathSync(path: PathLike, options?: { encoding?: BufferEncoding }) {
			if (isVirtualPath(path)) return state.vfs.realpathSync(toPath(path), options)
			return realFs.realpathSync(path, options)
		},
		rename(source: PathLike, destination: PathLike, callback) {
			callbackify(() => fsp.rename(source, destination), callback)
		},
		renameSync(source: PathLike, destination: PathLike) {
			return renameAnySync(toPath(source), toPath(destination))
		},
		rm(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.rm(path, resolvedOptions), resolvedCallback)
		},
		rmSync(path: PathLike, options?: RmOptions) {
			return rmAnySync(toPath(path), options)
		},
		rmdir(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.rmdir(path, resolvedOptions), resolvedCallback)
		},
		rmdirSync(path: PathLike) {
			return rmdirAnySync(toPath(path))
		},
		stat(path: PathLike, options: any, callback?: (error: NodeJS.ErrnoException | null, stats?: unknown) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.stat(path, resolvedOptions), resolvedCallback as never)
		},
		statSync(path: PathLike, options?: { bigint?: boolean; throwIfNoEntry?: boolean }) {
			try {
				if (isVirtualPath(path)) return state.vfs.statSync(toPath(path), options)
				return realFs.statSync(path, options as never)
			} catch (error) {
				if (options?.throwIfNoEntry === false && isEnoent(error)) return undefined
				throw error
			}
		},
		symlink(target: string, path: PathLike, type: any, callback?: (error: NodeJS.ErrnoException | null) => void) {
			const resolvedCallback = typeof type === 'function' ? type : callback
			const resolvedType = typeof type === 'function' ? undefined : type
			if (!resolvedCallback) return
			callbackify(() => fsp.symlink(target, path, resolvedType), resolvedCallback)
		},
		symlinkSync(target: string, path: PathLike, type?: string) {
			return symlinkAnySync(target, toPath(path), type)
		},
		unlink(path: PathLike, callback) {
			callbackify(() => fsp.unlink(path), callback)
		},
		unlinkSync(path: PathLike) {
			return unlinkAnySync(toPath(path))
		},
		writeFile(path: PathLike, data, options: any, callback?: (error: NodeJS.ErrnoException | null) => void) {
			const resolvedCallback = typeof options === 'function' ? options : callback
			const resolvedOptions = typeof options === 'function' ? undefined : options
			if (!resolvedCallback) return
			callbackify(() => fsp.writeFile(path, data, resolvedOptions), resolvedCallback)
		},
		writeFileSync(path: PathLike, data, options?) {
			return writeFileRawSync(toPath(path), data, options)
		},
	}

	return {
		mode: 'memory',
		root: state.root,
		fs,
		fsp,
		tmpdir: () => state.root,
		vfs: state.vfs,
	}
}

function wrapFixture(raw: FsFixture, runtime: FixtureFsApi): TestFixture {
	return Object.assign(raw, runtime, {
		async [Symbol.asyncDispose]() {
			await runtime.fsp.rm(raw.path, { recursive: true, force: true })
		},
	}) as TestFixture
}

export async function createFixture(
	source?: string | FileTree,
	options: CreateFixtureOptions = {},
): Promise<TestFixture> {
	const state = createMemoryState()
	const runtime = createVirtualRuntime(state)
	// Memory fixtures own their VFS/runtime. Ignore external fs/tempDir injection here.
	const { fs: _ignoredFs, tempDir: _ignoredTempDir, ...rest } = options
	const raw = await createRawFixture(source, {
		tempDir: state.root,
		fs: runtime.fsp as unknown as CreateFixtureOptions['fs'],
		...rest,
	})
	return wrapFixture(raw, runtime)
}

export async function createDiskFixture(
	source?: string | FileTree,
	options: CreateFixtureOptions = {},
): Promise<TestFixture> {
	const raw = await createRawFixture(source, options)
	const root = dirname(raw.path)
	return wrapFixture(raw, {
		mode: 'disk',
		root,
		fs: realFs as unknown as SupportedFs,
		fsp: realFsPromises as unknown as SupportedFsPromises,
		tmpdir: () => root,
	})
}
