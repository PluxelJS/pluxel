import { join, parse, resolve } from 'pathe'

export const HOST_PROFILE_TOKEN = '{profile}'

export type ResolvedProfiledPath = {
	path: string
	fallbackPath?: string
}

export type RuntimeStorageLayout = {
	configFile?: string
	pluginDataDir?: string
	packageStateFile?: string
	logsDir?: string
	logFile?: string
}

export type RuntimeStoragePaths = {
	configFile: string
	pluginDataDir: string
	packageStateFile: string
	logsDir: string
	logFile: string
}

export type MaterializeProfiledFileOptions = {
	profile?: string
	seedFile?: string | false
}

export function resolveProfiledPath(basePath: string, profile?: string): ResolvedProfiledPath {
	if (!profile) return { path: resolve(basePath) }

	if (basePath.includes(HOST_PROFILE_TOKEN)) {
		return { path: resolve(basePath.replaceAll(HOST_PROFILE_TOKEN, profile)) }
	}

	const parsed = parse(basePath)
	const name = parsed.name
	if (
		name.endsWith(`.${profile}`) ||
		name.endsWith(`-${profile}`) ||
		name.endsWith(`_${profile}`)
	) {
		return { path: resolve(basePath) }
	}

	const nextBase = `${name}.${profile}${parsed.ext}`
	const nextPath = parsed.dir ? join(parsed.dir, nextBase) : nextBase
	return { path: resolve(nextPath), fallbackPath: resolve(basePath) }
}

export function resolveRuntimeStoragePaths(
	root: string,
	layout: RuntimeStorageLayout = {},
): RuntimeStoragePaths {
	const rootDir = resolve(root)
	const logsDir = resolve(rootDir, layout.logsDir ?? 'logs')
	return {
		configFile: resolve(rootDir, layout.configFile ?? 'data/runtime/config.json'),
		pluginDataDir: resolve(rootDir, layout.pluginDataDir ?? 'data/plugin-data'),
		packageStateFile: resolve(
			rootDir,
			layout.packageStateFile ?? 'data/runtime/package-state.json',
		),
		logsDir,
		logFile: resolve(rootDir, layout.logFile ?? join(logsDir, 'runtime.log')),
	}
}
