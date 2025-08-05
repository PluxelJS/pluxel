// services/PluginScanner.ts
import { scanPackageEntryByPath, getAllTsFiles } from './utils'

/**
 * Scans directories for plugin entry paths, with concurrency control and fallback.
 */
export class PluginScanner {
	constructor(private batchSize = 5) {}

	async findEntries(dirs: string[]): Promise<string[]> {
		const success: string[] = []
		const failed: string[] = []

		for (let i = 0; i < dirs.length; i += this.batchSize) {
			const batch = dirs.slice(i, i + this.batchSize)
			const settled = await Promise.allSettled(
				batch.map((dir) => scanPackageEntryByPath(dir, true)),
			)

			settled.forEach((res, idx) => {
				if (res.status === 'fulfilled') {
					success.push(res.value)
				} else {
					failed.push(batch[idx])
				}
			})
		}

		// Fallback: scan all .ts files in failed dirs
		if (failed.length > 0) {
			const tsFiles = await getAllTsFiles(failed)
			return [...success, ...tsFiles]
		}
		return success
	}
}
