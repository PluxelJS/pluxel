import { posix } from 'node:path'
import { Bash, type IFileSystem } from 'just-bash'
import type { FileWrite, TextFile, WorkspaceTree } from '../shared/contracts.js'
import { conflict, decodeText, pathName } from './storage-validation.js'

export interface WorkspaceBashStore {
	tree(id: string): Promise<WorkspaceTree>
	readFile(id: string, path: string): Promise<TextFile>
	writeFile(id: string, input: FileWrite): Promise<TextFile>
	mkdir(id: string, path: string): Promise<WorkspaceTree>
	rename(
		id: string,
		input: { path: string; to: string; expectedVersion: string },
	): Promise<WorkspaceTree>
	remove(id: string, input: { path: string; expectedVersion: string }): Promise<WorkspaceTree>
}

const ROOT = '/workspace'
const MAX_WRITE = 1024 * 1024
const MAX_OUTPUT = 64 * 1024

/** No host filesystem/shell is given to Bash. Every mutation crosses WorkspaceStore. */
export async function runWorkspaceBash(
	store: WorkspaceBashStore,
	id: string,
	command: string,
	check: () => void,
	signal?: AbortSignal,
) {
	if (command.length > 32 * 1024) throw new Error('Bash script exceeds 32 KiB')
	check()
	signal?.throwIfAborted()
	const initial = await store.tree(id)
	const known = new Map(initial.entries.map((entry) => [entry.path, entry]))
	let operations = 0
	let written = 0
	let active = true
	const changed = new Set<string>()
	function guard() {
		check()
		signal?.throwIfAborted()
		if (!active) throw new Error('Bash execution has ended')
		if (++operations > 2000) throw new Error('Workspace filesystem operation limit exceeded')
	}
	function name(path: string) {
		guard()
		if (path.includes('\\') || path.includes(':'))
			throw new Error('Use virtual POSIX workspace paths')
		const absolute = posix.resolve(ROOT, path)
		if (absolute === ROOT) return ''
		if (!absolute.startsWith(ROOT + '/')) throw new Error('Path is outside /workspace')
		return pathName(absolute.slice(ROOT.length + 1))
	}
	function item(path: string) {
		const key = name(path)
		const value = known.get(key)
		if (!key) return { path: '', kind: 'directory' as const, size: 0, version: initial.revision }
		if (!value) throw new Error(`ENOENT: ${key}`)
		return value
	}
	// Refresh only our changed paths/ancestors, preserving unrelated stale versions.
	function update(tree: WorkspaceTree, paths: string[]) {
		for (const path of paths) changed.add(path)
		const affected = (key: string) =>
			paths.some((path) => key === path || key.startsWith(path + '/') || path.startsWith(key + '/'))
		const observed = new Map(tree.entries.map((entry) => [entry.path, entry]))
		for (const [key, entry] of known)
			if (!affected(key) && observed.get(key)?.version !== entry.version) throw conflict()
		for (const key of observed.keys()) if (!affected(key) && !known.has(key)) throw conflict()
		for (const key of known.keys())
			if (paths.some((path) => key === path || key.startsWith(path + '/'))) known.delete(key)
		for (const entry of tree.entries)
			if (
				paths.some(
					(path) =>
						entry.path === path ||
						entry.path.startsWith(path + '/') ||
						path.startsWith(entry.path + '/'),
				)
			)
				known.set(entry.path, entry)
	}
	const unsupported = async (): Promise<never> => {
		throw new Error('Workspace bash does not support links or permission/timestamp changes')
	}
	const fs: IFileSystem = {
		async readFile(path, encoding) {
			const bytes = await fs.readFileBuffer(path)
			return Buffer.from(bytes).toString(
				typeof encoding === 'string' ? encoding : (encoding?.encoding ?? 'utf8'),
			)
		},
		async readFileBuffer(path) {
			const entry = item(path)
			if (entry.kind !== 'file') throw new Error(`EISDIR: ${path}`)
			if (entry.binary) throw new Error('Binary asset content is not available to workspace bash')
			const file = await store.readFile(id, entry.path)
			guard()
			if (file.version !== entry.version) throw conflict()
			return Buffer.from(file.content)
		},
		async writeFile(path, content, encoding) {
			const key = name(path)
			if (!key) throw new Error('Cannot replace workspace root')
			const entry = known.get(key)
			if (entry?.binary) throw new Error('Cannot overwrite binary assets with workspace bash')
			if (entry?.kind === 'directory') throw new Error(`EISDIR: ${path}`)
			const bytes =
				typeof content === 'string'
					? Buffer.from(
							content,
							typeof encoding === 'string' ? encoding : (encoding?.encoding ?? 'utf8'),
						)
					: content
			written += bytes.length
			if (bytes.length > MAX_WRITE || written > 4 * MAX_WRITE)
				throw new Error('Workspace bash write limit exceeded')
			const text = decodeText(bytes)
			if (text === undefined) throw new Error('Workspace bash writes UTF-8 text only')
			const saved = await store.writeFile(id, {
				path: key,
				content: text,
				expectedVersion: entry?.version ?? null,
			})
			known.set(key, { path: key, kind: 'file', size: bytes.length, version: saved.version })
			changed.add(key)
			const tree = await store.tree(id)
			// Do not adopt an external replacement of the file we just saved.
			if (tree.entries.find((candidate) => candidate.path === key)?.version !== saved.version)
				throw conflict()
			update(tree, [key])
		},
		async appendFile(path, content, encoding) {
			const previous = (await fs.exists(path)) ? await fs.readFileBuffer(path) : new Uint8Array()
			const bytes =
				typeof content === 'string'
					? Buffer.from(
							content,
							typeof encoding === 'string' ? encoding : (encoding?.encoding ?? 'utf8'),
						)
					: content
			await fs.writeFile(path, Buffer.concat([previous, bytes]))
		},
		async exists(path) {
			guard()
			const absolute = posix.resolve(ROOT, path)
			if (absolute !== ROOT && !absolute.startsWith(ROOT + '/')) return false
			const key = name(path)
			return !key || known.has(key)
		},
		async stat(path) {
			const entry = item(path)
			return {
				isFile: entry.kind === 'file',
				isDirectory: entry.kind === 'directory',
				isSymbolicLink: false,
				mode: entry.kind === 'file' ? 0o644 : 0o755,
				size: entry.size,
				mtime: new Date(0),
			}
		},
		async mkdir(path, options) {
			const key = name(path)
			if (!key) return
			const parts = key.split('/')
			for (let i = options?.recursive ? 1 : parts.length; i <= parts.length; i++) {
				const next = parts.slice(0, i).join('/')
				const existing = known.get(next)
				if (existing) {
					if (existing.kind !== 'directory' || !options?.recursive)
						throw new Error(`EEXIST: ${next}`)
					continue
				}
				guard()
				update(await store.mkdir(id, next), [next])
			}
		},
		async readdir(path) {
			const entry = item(path)
			if (entry.kind !== 'directory') throw new Error(`ENOTDIR: ${path}`)
			return [...known.keys()]
				.filter((key) => (posix.dirname(key) === '.' ? '' : posix.dirname(key)) === entry.path)
				.map((key) => posix.basename(key))
		},
		async rm(path, options) {
			const key = name(path)
			if (!key) throw new Error('Cannot delete workspace root')
			const entry = known.get(key)
			if (!entry) {
				if (options?.force) return
				throw new Error(`ENOENT: ${key}`)
			}
			if (
				entry.kind === 'directory' &&
				!options?.recursive &&
				[...known.keys()].some((other) => other.startsWith(key + '/'))
			)
				throw new Error(`ENOTEMPTY: ${key}`)
			update(await store.remove(id, { path: key, expectedVersion: entry.version }), [key])
		},
		async cp(source, target, options) {
			const entry = item(source)
			name(target)
			if (entry.kind === 'directory') {
				if (!options?.recursive) throw new Error('Recursive copy requires -r')
				if (posix.resolve(ROOT, target).startsWith(posix.resolve(ROOT, source) + '/'))
					throw new Error('Cannot copy a directory into itself')
				await fs.mkdir(target, { recursive: true })
				for (const child of await fs.readdir(source))
					await fs.cp(posix.join(source, child), posix.join(target, child), options)
			} else await fs.writeFile(target, await fs.readFileBuffer(source))
		},
		async mv(source, target) {
			const entry = item(source)
			const to = name(target)
			if (!entry.path || !to) throw new Error('Cannot move workspace root')
			if (known.has(to))
				throw new Error('Move destination already exists; remove it explicitly first')
			update(await store.rename(id, { path: entry.path, to, expectedVersion: entry.version }), [
				entry.path,
				to,
			])
		},
		resolvePath(base, path) {
			guard()
			return posix.resolve(base, path)
		},
		getAllPaths() {
			guard()
			return [ROOT, ...[...known.keys()].map((key) => ROOT + '/' + key)]
		},
		chmod: unsupported,
		symlink: unsupported,
		link: unsupported,
		readlink: unsupported,
		utimes: unsupported,
		async lstat(path) {
			return fs.stat(path)
		},
		async realpath(path) {
			item(path)
			return posix.resolve(ROOT, path)
		},
	}
	const bash = new Bash({
		fs,
		cwd: ROOT,
		env: { HOME: ROOT },
		python: false,
		javascript: false,
		commands: [
			'echo',
			'printf',
			'cat',
			'ls',
			'mkdir',
			'rmdir',
			'rm',
			'cp',
			'mv',
			'pwd',
			'head',
			'tail',
			'wc',
			'stat',
			'grep',
			'rg',
			'sed',
			'awk',
			'sort',
			'uniq',
			'cut',
			'tr',
			'tee',
			'find',
			'basename',
			'dirname',
			'tree',
			'env',
			'printenv',
			'xargs',
			'true',
			'false',
			'jq',
			'diff',
			'seq',
			'expr',
			'bash',
			'sh',
		],
		executionLimitProfile: 'hardened',
		executionLimits: {
			maxExecutionTimeMs: 10_000,
			maxCommandCount: 1000,
			maxLoopIterations: 1000,
			maxOutputSize: MAX_OUTPUT,
			maxFileSystemBytes: 8 * MAX_WRITE,
		},
	})
	try {
		const result = await bash.exec(command, { signal })
		return {
			stdout: result.stdout.slice(0, MAX_OUTPUT),
			stderr: result.stderr.slice(0, MAX_OUTPUT),
			exitCode: result.exitCode,
			changed: [...changed],
			partialWritesPossible: true,
		}
	} catch (error) {
		signal?.throwIfAborted()
		check()
		return {
			stdout: '',
			stderr: error instanceof Error ? error.message : String(error),
			exitCode: 1,
			changed: [...changed],
			partialWritesPossible: true,
		}
	} finally {
		active = false
	}
}
