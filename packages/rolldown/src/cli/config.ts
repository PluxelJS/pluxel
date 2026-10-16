import { access } from 'node:fs/promises'
import { resolve } from 'pathe'
import { resolvePackageJsonPath } from './package-json'
import type { BuildRuntimeConfig } from './types'

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
	const packageJsonPath = await resolveProjectPackageJsonPath(projectRoot)
	const tsdownConfigPath = await discoverDefaultTsdownConfig(projectRoot)

	const context: BuildRuntimeConfig = {
		projectRoot,
		packageJsonPath,
		watch: Boolean(values.watch),
		debug: Boolean(values.debug),
	}

	if (tsdownConfigPath) {
		context.tsdownConfigPath = tsdownConfigPath
	}

	return context
}

async function resolveProjectPackageJsonPath(projectRoot: string) {
	try {
		return await resolvePackageJsonPath(projectRoot)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`Unable to find package.json under ${projectRoot}: ${reason}`, {
			cause: error,
		})
	}
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
