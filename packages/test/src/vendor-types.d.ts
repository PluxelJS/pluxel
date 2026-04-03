declare module 'fs-fixture' {
	type SymlinkType = 'file' | 'dir' | 'junction'
	type Symlink = { target: string; type?: SymlinkType }
	type FileTreeValue =
		| string
		| Buffer
		| FileTree
		| ((api: {
				fixturePath: string
				filePath: string
				getPath: (...subpaths: string[]) => string
				symlink: (targetPath: string, type?: SymlinkType) => Symlink
		  }) => string | Buffer | Symlink | FileTree)

	export type FileTree = Record<string, FileTreeValue>
	export type CreateFixtureOptions = {
		tempDir?: string | URL
		templateFilter?: (...args: unknown[]) => boolean
		fs?: unknown
	}
	export interface FsFixture {
		readonly path: string
		getPath(...subpaths: string[]): string
		exists(subpath?: string): Promise<boolean>
		rm(subpath?: string): Promise<void>
		cp(sourcePath: string, destinationSubpath?: string, options?: unknown): Promise<void>
		mkdir(folderPath: string): Promise<string | undefined>
		mv(sourcePath: string, destinationPath: string): Promise<void>
		readFile: typeof import('node:fs/promises').readFile
		readdir: typeof import('node:fs/promises').readdir
		writeFile: typeof import('node:fs/promises').writeFile
		readJson<T = unknown>(filePath: string): Promise<T>
		writeJson(filePath: string, json: unknown, space?: string | number): Promise<void>
		[Symbol.asyncDispose](): Promise<void>
	}
	export function createFixture(
		source?: string | FileTree,
		options?: CreateFixtureOptions,
	): Promise<FsFixture>
}

declare module '@platformatic/vfs' {
	import type { Readable } from 'node:stream'

	export interface VirtualStats {
		isFile(): boolean
		isDirectory(): boolean
		isSymbolicLink(): boolean
	}

	export interface VirtualDirent {
		name: string
		isFile(): boolean
		isDirectory(): boolean
		isSymbolicLink(): boolean
	}

	export interface VFSPromisesAPI {
		readFile(path: string, options?: unknown): Promise<any>
		writeFile(path: string, data: string | Buffer, options?: unknown): Promise<void>
		appendFile(path: string, data: string | Buffer, options?: unknown): Promise<void>
		stat(path: string, options?: unknown): Promise<VirtualStats>
		lstat(path: string, options?: unknown): Promise<VirtualStats>
		readdir(path: string, options?: unknown): Promise<string[] | VirtualDirent[]>
		mkdir(path: string, options?: unknown): Promise<string | undefined>
		rmdir(path: string): Promise<void>
		unlink(path: string): Promise<void>
		rename(oldPath: string, newPath: string): Promise<void>
		copyFile(src: string, dest: string, mode?: number): Promise<void>
		realpath(path: string, options?: unknown): Promise<string>
		readlink(path: string, options?: unknown): Promise<string>
		symlink(target: string, path: string, type?: string): Promise<void>
		access(path: string, mode?: number): Promise<void>
	}

	export interface VirtualFileSystem {
		promises: VFSPromisesAPI
		existsSync(path: string): boolean
		statSync(path: string, options?: unknown): VirtualStats
		lstatSync(path: string, options?: unknown): VirtualStats
		readFileSync(path: string, options?: unknown): any
		writeFileSync(path: string, data: string | Buffer, options?: unknown): void
		appendFileSync(path: string, data: string | Buffer, options?: unknown): void
		readdirSync(path: string, options?: unknown): string[] | VirtualDirent[]
		mkdirSync(path: string, options?: unknown): string | undefined
		rmdirSync(path: string): void
		unlinkSync(path: string): void
		renameSync(oldPath: string, newPath: string): void
		realpathSync(path: string, options?: unknown): string
		readlinkSync(path: string, options?: unknown): string
		symlinkSync(target: string, path: string, type?: string): void
		accessSync(path: string, mode?: number): void
		createReadStream(path: string, options?: unknown): Readable
	}

	export class MemoryProvider {}

	export function create(
		provider?: MemoryProvider,
		options?: { moduleHooks?: boolean },
	): VirtualFileSystem
}
