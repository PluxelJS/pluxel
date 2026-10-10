import { constants } from 'node:fs'
import { copyFile, mkdir, open, opendir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ResourceSource, TypstFiles, TypstTemplate } from './contracts.js'
import { TypstError } from './errors.js'

export interface ResourceLimits {
	readonly maxFiles: number
	readonly maxBytes: number
	readonly maxJsonDepth: number
	readonly maxJsonValues: number
}

function invalid(path: string, message: string): never {
	throw new TypstError('INVALID_INPUT', `${path}: ${message}`, { path })
}

function limit(path: string, message: string): never {
	throw new TypstError('LIMIT_EXCEEDED', `${path}: ${message}`, { path })
}

function segments(path: string): string[] {
	if (!path || path.length > 4096 || path.includes('\\') || path.includes('\0'))
		invalid(path, 'expected a canonical path')
	const parts = path.split('/')
	if (parts.length > 128) invalid(path.slice(0, 100), 'path exceeds 128 segments')
	if (parts.some((part) => !part || part === '.' || part === '..'))
		invalid(path, 'expected a canonical path without empty or dot segments')
	return parts
}

class Budget {
	bytes = 0
	files = 0
	constructor(
		readonly limits: ResourceLimits,
		readonly signal?: AbortSignal,
	) {
		signal?.throwIfAborted()
	}
	addBytes(bytes: number, path: string): void {
		this.signal?.throwIfAborted()
		this.bytes += bytes
		if (this.bytes > this.limits.maxBytes)
			limit(path, `resource bytes exceed ${this.limits.maxBytes}`)
	}
	addFile(path: string): void {
		this.signal?.throwIfAborted()
		if (++this.files > this.limits.maxFiles)
			limit(path, `resource count exceeds ${this.limits.maxFiles}`)
	}
}

async function copy(source: string, destination: string, budget: Budget): Promise<void> {
	const info = await stat(source)
	if (!info.isFile()) invalid(source, 'expected a regular file')
	budget.addBytes(info.size, source)
	await copyFile(source, destination, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
	const copied = await stat(destination)
	if (copied.size !== info.size) invalid(source, 'file changed while preparing its snapshot')
	budget.signal?.throwIfAborted()
}

/** Caller owns destination, including removal after any preparation failure. */
export async function prepareTemplate(
	template: TypstTemplate,
	destination: string,
	limits: ResourceLimits,
	signal?: AbortSignal,
): Promise<{ entry: string; bytes: number }> {
	if (typeof template.root !== 'string' || !isAbsolute(template.root))
		invalid('root', 'expected an absolute directory')
	if (typeof template.entry !== 'string' || isAbsolute(template.entry))
		invalid('entry', 'expected a relative file path')
	const entry = segments(template.entry).join('/')
	if (entry.split('/')[0] === 'inputs') invalid(entry, '/inputs is reserved for dynamic resources')
	const sourceRoot = await realpath(template.root)
	const budget = new Budget(limits, signal)
	const ancestors = new Set<string>()
	async function visit(source: string, target: string, depth: number): Promise<void> {
		signal?.throwIfAborted()
		if (depth > 128) limit(source, 'template directory depth exceeds 128')
		const resolved = await realpath(source)
		const rel = relative(sourceRoot, resolved)
		if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			invalid(source, 'symbolic link escapes template root')
		const info = await stat(resolved)
		if (info.isDirectory()) {
			if (ancestors.has(resolved)) invalid(source, 'symbolic link cycle')
			ancestors.add(resolved)
			await mkdir(target, { recursive: true })
			const directory = await opendir(resolved)
			for await (const child of directory) {
				budget.addFile(join(source, child.name))
				if (depth === 0 && child.name === 'inputs')
					invalid(source, '/inputs is reserved for dynamic resources')
				await visit(join(source, child.name), join(target, child.name), depth + 1)
			}
			ancestors.delete(resolved)
		} else {
			await copy(resolved, target, budget)
		}
	}
	await visit(sourceRoot, destination, 0)
	const entryInfo = await stat(join(destination, entry))
	if (!entryInfo.isFile()) invalid(entry, 'entry must be a regular file')
	return { entry, bytes: budget.bytes }
}

const CHUNK = 16_384

/** Slice on Unicode boundaries so UTF-8 and JSON encoding preserve surrogate pairs. */
function* strings(value: string): Generator<string> {
	for (let offset = 0; offset < value.length;) {
		let end = Math.min(offset + CHUNK, value.length)
		const last = value.charCodeAt(end - 1)
		if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--
		yield value.slice(offset, end)
		offset = end
	}
}

async function writeResource(
	source: ResourceSource,
	path: string,
	target: string,
	budget: Budget,
): Promise<void> {
	if (source.kind === 'file') {
		const sourcePath = source.path instanceof URL ? fileURLToPath(source.path) : source.path
		if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath))
			invalid(path, 'file source must be an absolute path or file: URL')
		await copy(sourcePath, target, budget)
		return
	}
	const file = await open(target, 'wx')
	let pending = ''
	async function flush(): Promise<void> {
		if (pending) {
			await file.writeFile(pending, 'utf8')
			pending = ''
		}
	}
	async function append(text: string): Promise<void> {
		budget.addBytes(Buffer.byteLength(text), path)
		pending += text
		if (pending.length >= CHUNK) await flush()
	}
	async function quoted(text: string): Promise<void> {
		await append('"')
		for (const part of strings(text)) await append(JSON.stringify(part).slice(1, -1))
		await append('"')
	}
	let values = 0
	const ancestors = new Set<object>()
	async function json(value: unknown, location: string, depth: number): Promise<void> {
		if (++values > budget.limits.maxJsonValues)
			limit(path, `JSON values exceed ${budget.limits.maxJsonValues}`)
		if (depth > budget.limits.maxJsonDepth)
			limit(path, `JSON depth exceeds ${budget.limits.maxJsonDepth}`)
		if (values % 256 === 0) {
			await setImmediate()
			budget.signal?.throwIfAborted()
		}
		if (value === null || typeof value === 'boolean') return append(String(value))
		if (typeof value === 'string') return quoted(value)
		if (typeof value === 'number' && Number.isFinite(value)) return append(JSON.stringify(value))
		if (typeof value !== 'object' || value === null)
			invalid(`${path} ${location}`, 'expected an encodable JSON value')
		if (ancestors.has(value)) invalid(`${path} ${location}`, 'cyclic JSON value')
		const array = Array.isArray(value)
		if (
			!array &&
			Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null
		)
			invalid(`${path} ${location}`, 'expected a plain JSON object')
		if (Object.getOwnPropertySymbols(value).length > 0)
			invalid(`${path} ${location}`, 'symbol properties are not JSON')
		ancestors.add(value)
		await append(array ? '[' : '{')
		let count = 0
		if (array) {
			if (value.length > budget.limits.maxJsonValues - values)
				limit(path, 'JSON array exceeds value budget')
			for (let index = 0; index < value.length; index++) {
				const property = Object.getOwnPropertyDescriptor(value, String(index))
				if (!property || !('value' in property))
					invalid(`${path} ${location}[${index}]`, 'sparse arrays and accessors are not JSON')
				if (index) await append(',')
				await json(property.value, `${location}[${index}]`, depth + 1)
			}
			for (const key in value) {
				if (
					Object.hasOwn(value, key) &&
					(!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)
				)
					invalid(`${path} ${location}`, 'extra array properties are not JSON')
			}
		} else {
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue
				const property = Object.getOwnPropertyDescriptor(value, key)!
				if (!('value' in property)) invalid(`${path} ${location}`, 'accessors are not JSON')
				if (count++) await append(',')
				await quoted(key)
				await append(':')
				await json(property.value, `${location}[${JSON.stringify(key.slice(0, 100))}]`, depth + 1)
			}
		}
		await append(array ? ']' : '}')
		ancestors.delete(value)
	}
	try {
		switch (source.kind) {
			case 'json':
				await json(source.value, '$', 0)
				break
			case 'text':
				if (typeof source.text !== 'string') invalid(path, 'expected text string')
				for (const part of strings(source.text)) await append(part)
				break
			case 'bytes':
				if (!(source.bytes instanceof Uint8Array)) invalid(path, 'expected Uint8Array')
				budget.addBytes(source.bytes.byteLength, path)
				for (let offset = 0; offset < source.bytes.byteLength; offset += 65_536) {
					budget.signal?.throwIfAborted()
					await file.writeFile(source.bytes.subarray(offset, offset + 65_536))
				}
				break
			default:
				invalid(path, 'unknown resource kind')
		}
		await flush()
	} finally {
		await file.close()
	}
}

/** Writes a new inputs tree. The caller owns destination and failure cleanup. */
export async function prepareInputs(
	files: TypstFiles,
	destination: string,
	limits: ResourceLimits,
	signal?: AbortSignal,
): Promise<{ bytes: number }> {
	if (!files || typeof files !== 'object' || Array.isArray(files))
		invalid('files', 'expected a file map')
	const budget = new Budget(limits, signal)
	const paths = new Set<string>()
	const directories = new Set<string>()
	for (const path in files) {
		if (!Object.hasOwn(files, path)) continue
		budget.addFile(path)
		if (!path.startsWith('/inputs/')) invalid(path, 'logical paths must start with /inputs/')
		const parts = segments(path.slice(1))
		if (directories.has(path)) invalid(path, 'file/directory conflict')
		for (let index = 1; index < parts.length; index++) {
			const parent = `/${parts.slice(0, index).join('/')}`
			if (paths.has(parent)) invalid(path, 'file/directory conflict')
			directories.add(parent)
		}
		paths.add(path)
		if (budget.files % 256 === 0) {
			await setImmediate()
			signal?.throwIfAborted()
		}
	}
	await mkdir(join(destination, 'inputs'), { recursive: true })
	for (const path of paths) {
		const source = files[path]
		if (!source || typeof source !== 'object') invalid(path, 'expected a resource source')
		const parts = path.slice(1).split('/')
		await mkdir(join(destination, ...parts.slice(0, -1)), { recursive: true })
		await writeResource(source, path, join(destination, ...parts), budget)
	}
	return { bytes: budget.bytes }
}
