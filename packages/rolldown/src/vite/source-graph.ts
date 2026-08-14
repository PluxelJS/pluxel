export type SourceGraphModule = Readonly<{
	file?: string | null
	importedModules?: Iterable<SourceGraphModule>
	clientImportedModules?: Iterable<SourceGraphModule>
	ssrImportedModules?: Iterable<SourceGraphModule>
}>

export type CollectSourceGraphFilesOptions = Readonly<{
	include?: (filePath: string) => boolean
}>

/** Collect a deterministic file snapshot from a target-specific Vite module graph. */
export function collectSourceGraphFiles(
	root: SourceGraphModule,
	options: CollectSourceGraphFilesOptions = {},
): string[] {
	const include = options.include ?? (() => true)
	const files = new Set<string>()
	const visited = new Set<SourceGraphModule>()
	const stack: SourceGraphModule[] = [root]
	while (stack.length > 0) {
		const module = stack.pop()!
		if (visited.has(module)) continue
		visited.add(module)
		if (module.file && include(module.file)) files.add(module.file)
		for (const imports of [
			module.importedModules,
			module.clientImportedModules,
			module.ssrImportedModules,
		]) {
			if (!imports) continue
			for (const dependency of imports) stack.push(dependency)
		}
	}
	return [...files].sort()
}
