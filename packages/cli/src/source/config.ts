import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'pathe'
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser'

export const SOURCE_CONFIG_FILE = 'pluxel.sources.jsonc'
export const SOURCE_REGISTRY_ENV = 'PLUXEL_SOURCE_REGISTRY'

export interface SourceProjectConfig {
	version: 1
	sources: string[]
	singletons: string[]
}

export interface SourceCheckoutRegistry {
	version: 1
	checkouts: Record<string, string>
}

export function readSourceProjectConfig(
	root: string,
	configPath = SOURCE_CONFIG_FILE,
): SourceProjectConfig {
	const path = isAbsolute(configPath) ? configPath : resolve(root, configPath)
	if (!existsSync(path)) {
		throw new Error(`Missing source workspace config: ${path}`)
	}
	return parseSourceProjectConfig(readFileSync(path, 'utf8'), path)
}

export function tryReadSourceProjectConfig(
	root: string,
	configPath = SOURCE_CONFIG_FILE,
): SourceProjectConfig | undefined {
	const path = isAbsolute(configPath) ? configPath : resolve(root, configPath)
	if (!existsSync(path)) return undefined
	return parseSourceProjectConfig(readFileSync(path, 'utf8'), path)
}

export function parseSourceProjectConfig(contents: string, path = SOURCE_CONFIG_FILE) {
	const value = parseJsonc(contents, path)
	assertRecord(value, path)
	assertKnownKeys(value, ['version', 'sources', 'singletons'], path)
	if (value.version !== 1) {
		throw new Error(`${path}: version must be 1`)
	}
	if (!Array.isArray(value.sources) || value.sources.length === 0) {
		throw new Error(`${path}: sources must be a non-empty array`)
	}

	const sources = value.sources.map((source, index) => {
		if (typeof source !== 'string' || !source.trim()) {
			throw new Error(`${path}: sources[${index}] must be a non-empty repository URL`)
		}
		return normalizeRepositoryIdentity(source)
	})
	const unique = [...new Set(sources)]
	if (unique.length !== sources.length) {
		throw new Error(`${path}: sources must not contain duplicate repositories`)
	}
	const rawSingletons = value.singletons ?? []
	if (!Array.isArray(rawSingletons)) throw new Error(`${path}: singletons must be an array`)
	const singletons = rawSingletons.map((singleton, index) => {
		if (typeof singleton !== 'string' || !isPackageName(singleton)) {
			throw new Error(`${path}: singletons[${index}] must be a lowercase npm package name`)
		}
		return singleton
	})
	if (new Set(singletons).size !== singletons.length) {
		throw new Error(`${path}: singletons must not contain duplicate packages`)
	}
	return { version: 1, sources: unique, singletons } satisfies SourceProjectConfig
}

export function resolveSourceRegistryPath(
	explicit: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
) {
	if (explicit?.trim()) return resolve(explicit)
	if (env[SOURCE_REGISTRY_ENV]?.trim()) return resolve(env[SOURCE_REGISTRY_ENV]!)
	const configRoot = env.XDG_CONFIG_HOME?.trim()
		? resolve(env.XDG_CONFIG_HOME)
		: env.APPDATA?.trim()
			? resolve(env.APPDATA)
			: resolve(homedir(), '.config')
	return resolve(configRoot, 'pluxel', 'source-checkouts.json')
}

export function readSourceCheckoutRegistry(path: string): SourceCheckoutRegistry {
	if (!existsSync(path)) {
		return { version: 1, checkouts: {} }
	}
	const value = parseJsonc(readFileSync(path, 'utf8'), path)
	assertRecord(value, path)
	assertKnownKeys(value, ['version', 'checkouts'], path)
	if (value.version !== 1) throw new Error(`${path}: version must be 1`)
	assertRecord(value.checkouts, `${path}: checkouts`)

	const checkouts: Record<string, string> = {}
	for (const [rawRepository, rawPath] of Object.entries(value.checkouts)) {
		if (typeof rawPath !== 'string' || !rawPath.trim()) {
			throw new Error(`${path}: checkout path for ${rawRepository} must be a non-empty string`)
		}
		if (!isAbsolute(rawPath)) {
			throw new Error(`${path}: checkout path for ${rawRepository} must be absolute`)
		}
		const repository = normalizeRepositoryIdentity(rawRepository)
		if (Object.hasOwn(checkouts, repository)) {
			throw new Error(`${path}: duplicate normalized repository ${repository}`)
		}
		checkouts[repository] = resolve(rawPath)
	}
	return { version: 1, checkouts }
}

export function normalizeRepositoryIdentity(input: string): string {
	let value = input.trim()
	if (!value) throw new Error('Repository identity cannot be empty')
	value = value.replace(/^git\+/, '')

	const scp = value.includes('://') ? undefined : value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
	if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
		value = `https://${scp[1]}/${scp[2]}`
	}
	if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
		value = `https://${value.replace(/^\/+/, '')}`
	}

	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error(`Invalid repository URL: ${input}`)
	}
	if (!url.hostname || !url.pathname || url.pathname === '/') {
		throw new Error(`Invalid repository URL: ${input}`)
	}
	const path = url.pathname
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '')
		.replace(/^\/+/, '')
	if (!path) throw new Error(`Invalid repository URL: ${input}`)
	return `https://${url.host.toLowerCase()}/${path}`
}

function parseJsonc(contents: string, path: string): unknown {
	const errors: ParseError[] = []
	const value = parse(contents, errors, { allowTrailingComma: true, disallowComments: false })
	if (errors.length > 0) {
		const details = errors
			.map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
			.join(', ')
		throw new Error(`${path}: invalid JSONC (${details})`)
	}
	return value
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${path}: expected an object`)
	}
}

function assertKnownKeys(value: Record<string, unknown>, keys: string[], path: string) {
	const known = new Set(keys)
	const unknown = Object.keys(value).filter((key) => !known.has(key))
	if (unknown.length > 0) {
		throw new Error(
			`${path}: unknown field${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}`,
		)
	}
}

function isPackageName(value: string) {
	return /^(?:@[a-z\d][a-z\d._-]*\/)?[a-z\d][a-z\d._-]*$/.test(value)
}
