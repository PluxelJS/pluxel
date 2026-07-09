import { join, resolve } from 'pathe'

export type RuntimeStorageLayout = {
	persistenceDir?: string
	packageStateFile?: string
	logsDir?: string
	logFile?: string
}

export type RuntimeStoragePaths = {
	persistenceDir: string
	packageStateFile: string
	logsDir: string
	logFile: string
}

export function resolveRuntimeStoragePaths(
	root: string,
	layout: RuntimeStorageLayout = {},
): RuntimeStoragePaths {
	const rootDir = resolve(root)
	const logsDir = resolve(rootDir, layout.logsDir ?? 'logs')
	return {
		persistenceDir: resolve(rootDir, layout.persistenceDir ?? 'data/persistence'),
		packageStateFile: resolve(
			rootDir,
			layout.packageStateFile ?? 'data/runtime/package-state.json',
		),
		logsDir,
		logFile: resolve(rootDir, layout.logFile ?? join(logsDir, 'runtime.log')),
	}
}
