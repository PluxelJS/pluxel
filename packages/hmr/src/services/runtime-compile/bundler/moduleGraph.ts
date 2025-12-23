import type { ModuleNode } from 'vite'

export type CollectModuleGraphFilesOptions = {
	include?: (filePath: string) => boolean
}

export function collectModuleGraphFiles(
	root: ModuleNode,
	opts: CollectModuleGraphFilesOptions = {},
): string[] {
	const include = opts.include ?? (() => true)
	const files = new Set<string>()
	const visited = new Set<ModuleNode>()
	const stack: ModuleNode[] = [root]

	while (stack.length) {
		const node = stack.pop()!
		if (visited.has(node)) continue
		visited.add(node)

		if (node.file && include(node.file)) {
			files.add(node.file)
		}

		for (const next of getImportedModules(node)) {
			stack.push(next)
		}
	}

	// moduleGraph 里有时会缺失一些依赖（例如未 transform 的模块），兜底补齐入口自身
	if (root.file && include(root.file)) {
		files.add(root.file)
	}

	return Array.from(files).sort()
}

function getImportedModules(node: ModuleNode): Iterable<ModuleNode> {
	const out = new Set<ModuleNode>()
	for (const next of node.importedModules) out.add(next)
	// Some Vite versions keep per-environment sets.
	for (const next of node.clientImportedModules) out.add(next)
	for (const next of node.ssrImportedModules) out.add(next)
	return out
}
