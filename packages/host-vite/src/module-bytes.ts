import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { normalizePath, type Plugin } from 'vite'
import { HOST_VITE_ENVIRONMENT } from './environment'

/** Remember bytes at Vite load, so republishing a wrapper never evicts unchanged shared modules. */
export function createHostModuleBytes() {
	const loaded = new Map<string, string>()
	const digest = async (file: string) =>
		createHash('sha256')
			.update(await readFile(file))
			.digest('hex')
	const plugin: Plugin = {
		name: 'pluxel:host-module-bytes',
		enforce: 'pre',
		applyToEnvironment: (environment) => environment.name === HOST_VITE_ENVIRONMENT,
		async load(id) {
			const file = id.split(/[?#]/)[0]!
			if (isAbsolute(file)) {
				try {
					loaded.set(normalizePath(file), await digest(file))
				} catch (error) {
					if (
						!error ||
						typeof error !== 'object' ||
						!('code' in error) ||
						!['ENOENT', 'EISDIR'].includes(String(error.code))
					)
						throw error
				}
			}
			return null
		},
	}
	return {
		plugin,
		/** A late dependency notification cannot evict bytes already loaded through another entry. */
		async unchanged(file: string): Promise<boolean> {
			const previous = loaded.get(normalizePath(file))
			if (!previous) return false
			try {
				return (await digest(file)) === previous
			} catch (error) {
				if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
					return false
				throw error
			}
		},
		async changed(files: Iterable<string>): Promise<string[]> {
			const changed: string[] = []
			for (const file of files) {
				const previous = loaded.get(normalizePath(file))
				if (!previous) continue
				try {
					if ((await digest(file)) !== previous) changed.push(file)
				} catch (error) {
					if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
						changed.push(file)
					else throw error
				}
			}
			return changed
		},
	}
}
