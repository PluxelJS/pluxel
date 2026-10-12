import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { safePath } from './storage-validation.js'

export function inputData(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Input data must be a JSON object')
	const encoded = JSON.stringify(value)
	if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw new Error('Input data exceeds 4 MiB')
	return JSON.parse(encoded)
}
export function inputRevision(
	workspaceRevision: string,
	entry: string,
	data: Record<string, unknown>,
): string {
	return createHash('sha256')
		.update(JSON.stringify([workspaceRevision, entry, data]))
		.digest('hex')
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
	get(id: string, entry: string): Promise<Record<string, unknown>> {
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
