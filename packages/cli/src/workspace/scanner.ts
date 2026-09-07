import { dirname, relative, resolve } from 'pathe'
import { loadOfficialCapability } from '../capability-loader'

type WorkspaceFsModule = typeof import('@pluxel/rolldown/workspace/fs')

export async function scanWorkspaceDirs(root: string, base?: string) {
	const { crawlFilesAbs, DEFAULT_IGNORED_DIR_NAMES } =
		await loadOfficialCapability<WorkspaceFsModule>('rolldown-workspace-fs')
	const target = base ? resolve(root, base) : root
	const files = await crawlFilesAbs({
		roots: [target],
		ignoreDirNames: DEFAULT_IGNORED_DIR_NAMES,
		fileFilter: (p) => p.endsWith('package.json'),
	})
	return dedupe(
		files.map((file) => relative(root, dirname(file)).replaceAll('\\', '/')).filter(Boolean),
	)
}

function dedupe(list: string[]) {
	return [...new Set(list)].sort((a, b) => a.localeCompare(b))
}
