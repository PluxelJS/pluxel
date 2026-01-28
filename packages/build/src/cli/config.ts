import { access } from 'node:fs/promises'
import { resolve } from 'pathe'
import { resolvePackageJSON } from 'pkg-types'
import { resolvePluginEnv } from './env'
import type { BuildRuntimeConfig } from './types'

const ENV_TSDOWN_CONFIG = 'PLUXEL_TSDOWN_CONFIG'
const DEFAULT_TSDOWN_CONFIG_FILES = [
	'tsdown.config.ts',
	'tsdown.config.mts',
	'tsdown.config.cts',
	'tsdown.config.js',
	'tsdown.config.mjs',
	'tsdown.config.cjs',
	'tsdown.config.json',
]

export interface BuildCommandArgsShape {
	watch?: boolean
	debug?: boolean
}

export async function resolveBuildContext(
	values: BuildCommandArgsShape,
): Promise<BuildRuntimeConfig> {
	const projectRoot = process.cwd()
	const envConfig = resolvePluginEnv()
	const packageJsonPath = await resolvePackageJsonPath(projectRoot)
	const tsdownConfigPath =
		resolveOverridePath(process.env[ENV_TSDOWN_CONFIG], projectRoot) ??
		(await discoverDefaultTsdownConfig(projectRoot))

	const context: BuildRuntimeConfig = {
		projectRoot,
		pluginPrefixes: envConfig.pluginPrefixes,
		manifestField: envConfig.manifestField,
		packageJsonPath,
		watch: Boolean(values.watch),
		debug: Boolean(values.debug),
	}

	if (tsdownConfigPath) {
		context.tsdownConfigPath = tsdownConfigPath
	}

	return context
}

async function resolvePackageJsonPath(projectRoot: string) {
	try {
		return await resolvePackageJSON(projectRoot)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`Unable to find package.json under ${projectRoot}: ${reason}`)
	}
}

function resolveOverridePath(pathInput: string | undefined, projectRoot: string) {
	if (!pathInput) return undefined
	return resolve(projectRoot, pathInput)
}

async function discoverDefaultTsdownConfig(projectRoot: string) {
	for (const candidate of DEFAULT_TSDOWN_CONFIG_FILES) {
		const fullPath = resolve(projectRoot, candidate)
		if (await fileExists(fullPath)) {
			return fullPath
		}
	}
	return undefined
}

async function fileExists(path: string) {
	try {
		await access(path)
		return true
	} catch {
		return false
	}
}

