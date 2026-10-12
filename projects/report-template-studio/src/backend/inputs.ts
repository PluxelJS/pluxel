import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safePath } from './storage-validation.js'
import type { JsonObject, JsonValue } from '../shared/contracts.js'

/** Validate before cloning: JSON encoding must never silently drop caller values. */
export function inputData(value: unknown): JsonObject {
	const invalid = (path: (string | number)[], message: string): never => {
		throw Object.assign(new Error(message), {
			code: 'INVALID_INPUT',
			issues: [{ path, rule: 'json', message }],
		})
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid(['data'], 'Input data must be a JSON object')
	const ancestors = new Set<object>()
	let count = 0
	function clone(item: unknown, path: (string | number)[], depth: number): JsonValue {
		if (++count > 1_000_000 || depth > 64) invalid(path, 'Input JSON exceeds complexity limits')
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
		if (typeof item === 'number' && Number.isFinite(item)) return item
		if (!item || typeof item !== 'object') invalid(path, 'Expected a finite JSON value')
		const object = item as object
		if (ancestors.has(object)) invalid(path, 'Input JSON cannot contain cycles')
		if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
			invalid(path, 'Input JSON objects must have ordinary or null prototypes')
		if (Object.getOwnPropertySymbols(item).length > 0)
			invalid(path, 'Input JSON cannot contain symbol keys')
		ancestors.add(object)
		try {
			if (Array.isArray(item)) {
				if (Object.keys(item).length !== item.length)
					invalid(path, 'Input JSON arrays must be dense and have no extra properties')
				return Array.from({ length: item.length }, (_, index) => {
					const property = Object.getOwnPropertyDescriptor(item, String(index))
					if (!property || !('value' in property))
						invalid([...path, index], 'Input JSON cannot contain accessors')
					return clone(property!.value, [...path, index], depth + 1)
				})
			}
			const output: JsonObject = {}
			for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
				if (!property.enumerable || !('value' in property))
					invalid([...path, key], 'Input JSON must contain enumerable data properties')
				Object.defineProperty(output, key, {
					value: clone(property.value, [...path, key], depth + 1),
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
			return output
		} finally {
			ancestors.delete(object)
		}
	}
	const result = clone(value, ['data'], 0) as JsonObject
	if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
		throw Object.assign(new Error('Input data exceeds 4 MiB'), { code: 'LIMIT_EXCEEDED' })
	return result
}
/** Studio state lives outside workspace sources and therefore outside exported ZIPs. */
export class InputStore {
	private queue: Promise<unknown> = Promise.resolve()
	constructor(private readonly root: string) {}
	private path(id: string, entry: string) {
		return join(
			this.root,
			createHash('sha256')
				.update(JSON.stringify([id, entry]))
				.digest('hex') + '.json',
		)
	}
	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.queue.then(operation)
		this.queue = task.catch(() => {})
		return task
	}
	get(id: string, entry: string): Promise<JsonObject> {
		return this.serial(async () => {
			try {
				return inputData(JSON.parse(await readFile(await safePath(this.path(id, entry)), 'utf8')))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
				throw error
			}
		})
	}
	/** Preserve original keys until the enclosing source rename has committed. */
	copyEntries(id: string, entries: { from: string; to: string }[]) {
		return this.serial(async () => {
			const written: { path: string; before?: Buffer }[] = []
			try {
				for (const entry of entries) {
					if (entry.from === entry.to) continue
					let source: Buffer
					try {
						source = await readFile(await safePath(this.path(id, entry.from)))
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
						throw error
					}
					const path = await safePath(this.path(id, entry.to))
					let before: Buffer | undefined
					try {
						before = await readFile(path)
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
					}
					written.push({ path, before })
					const temporary = path + '.' + randomUUID() + '.tmp'
					try {
						await writeFile(temporary, source, { flag: 'wx' })
						await rename(temporary, path)
					} finally {
						await rm(temporary, { force: true })
					}
				}
			} catch (error) {
				for (const { path, before } of written.toReversed()) {
					if (before) await writeFile(path, before)
					else await rm(path, { force: true })
				}
				throw error
			}
		})
	}

	set(id: string, entry: string, value: unknown) {
		const data = inputData(value)
		return this.serial(async () => {
			await mkdir(await safePath(this.root), { recursive: true })
			const target = await safePath(this.path(id, entry))
			const temporary = target + '.' + randomUUID() + '.tmp'
			try {
				await writeFile(temporary, JSON.stringify(data), { flag: 'wx' })
				await rename(temporary, target)
			} finally {
				await rm(temporary, { force: true })
			}
			return data
		})
	}
}
