import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import pkg from '../package.json'

type PackageManifest = {
	name?: string
	version?: string
}

export type OfficialCapabilityId =
	| 'rolldown-build'
	| 'rolldown-database'
	| 'rolldown-distribution'
	| 'rolldown-workspace-fs'
	| 'rolldown-workspace-info'
	| 'runtime-dynamic-hmr-diagnose'
	| 'market'

type OfficialCapabilityMetadata = {
	command: string
	owner: '@pluxel/rolldown' | '@pluxel/runtime-dynamic' | '@pluxel/market'
	subpath: '.' | `./${string}`
	install: string
}

const STARTUP_CWD_SYMBOL = Symbol.for('pluxel.cli.startupCwd')

const OFFICIAL_CAPABILITIES = {
	'rolldown-build': {
		command: 'build',
		owner: '@pluxel/rolldown',
		subpath: './build',
		install: 'pnpm add -D @pluxel/rolldown',
	},
	'rolldown-database': {
		command: 'database',
		owner: '@pluxel/rolldown',
		subpath: './database',
		install: 'pnpm add -D @pluxel/rolldown',
	},
	'rolldown-distribution': {
		command: 'distribution',
		owner: '@pluxel/rolldown',
		subpath: './distribution',
		install: 'pnpm add -D @pluxel/rolldown',
	},
	'rolldown-workspace-fs': {
		command: 'workspace',
		owner: '@pluxel/rolldown',
		subpath: './workspace/fs',
		install: 'pnpm add -D @pluxel/rolldown',
	},
	'rolldown-workspace-info': {
		command: 'workspace',
		owner: '@pluxel/rolldown',
		subpath: './workspace/info',
		install: 'pnpm add -D @pluxel/rolldown',
	},
	'runtime-dynamic-hmr-diagnose': {
		command: 'hmr',
		owner: '@pluxel/runtime-dynamic',
		subpath: './hmr/diagnose',
		install: 'pnpm add -D @pluxel/runtime-dynamic',
	},
	market: {
		command: 'publish --webhook',
		owner: '@pluxel/market',
		subpath: '.',
		install: 'pnpm add -D @pluxel/market',
	},
} satisfies Record<OfficialCapabilityId, OfficialCapabilityMetadata>

export type OfficialCapabilityErrorCode =
	| 'PLUXEL_CAPABILITY_OWNER_MISSING'
	| 'PLUXEL_CAPABILITY_OWNER_INCOMPATIBLE'
	| 'PLUXEL_CAPABILITY_SUBPATH_MISSING'
	| 'PLUXEL_CAPABILITY_IMPORT_FAILED'

export class OfficialCapabilityError extends Error {
	readonly code: OfficialCapabilityErrorCode
	readonly owner: string
	readonly subpath: string
	readonly cwd: string

	constructor(params: {
		code: OfficialCapabilityErrorCode
		message: string
		owner: string
		subpath: string
		cwd: string
		cause?: unknown
	}) {
		super(params.message, { cause: params.cause })
		this.name = 'OfficialCapabilityError'
		this.code = params.code
		this.owner = params.owner
		this.subpath = params.subpath
		this.cwd = params.cwd
	}
}

const importCache = new Map<string, Promise<unknown>>()

export async function loadOfficialCapability<T>(
	id: OfficialCapabilityId,
	options: { cwd?: string } = {},
): Promise<T> {
	const metadata = OFFICIAL_CAPABILITIES[id]
	const cwd = resolve(options.cwd ?? getStartupCwd())
	const cacheKey = `${cwd}\0${metadata.owner}\0${metadata.subpath}`
	let promise = importCache.get(cacheKey)
	if (!promise) {
		promise = loadOfficialCapabilityUncached<T>(metadata, cwd)
		importCache.set(cacheKey, promise)
	}
	return (await promise) as T
}

export function formatOfficialCapabilityError(error: OfficialCapabilityError): string {
	return error.message
}

async function loadOfficialCapabilityUncached<T>(
	metadata: OfficialCapabilityMetadata,
	cwd: string,
): Promise<T> {
	const projectRequire = createRequire(resolve(cwd, 'package.json'))
	const ownerManifestSpecifier = `${metadata.owner}/package.json`
	const importSpecifier =
		metadata.subpath === '.' ? metadata.owner : `${metadata.owner}/${metadata.subpath.slice(2)}`

	let ownerManifestPath: string
	try {
		ownerManifestPath = projectRequire.resolve(ownerManifestSpecifier)
	} catch (cause) {
		throw ownerMissingError(metadata, cwd, cause)
	}

	const ownerManifest = {
		path: ownerManifestPath,
		data: readPackageManifest(await readFile(ownerManifestPath, 'utf8'), ownerManifestPath),
	}
	if (ownerManifest.data.name !== metadata.owner) {
		throw ownerMissingError(
			metadata,
			cwd,
			new Error(
				`Resolved owner manifest ${ownerManifestPath} declares ${ownerManifest.data.name ?? 'no package name'}.`,
			),
		)
	}
	await assertOwnerVersion(metadata, ownerManifest, cwd)

	let resolvedImport: string
	try {
		resolvedImport = projectRequire.resolve(importSpecifier)
	} catch (cause) {
		throw subpathMissingError(metadata, ownerManifest, cwd, cause)
	}

	try {
		return (await import(pathToFileURL(resolvedImport).href)) as T
	} catch (cause) {
		throw importFailedError(metadata, resolvedImport, cwd, cause)
	}
}

async function assertOwnerVersion(
	metadata: OfficialCapabilityMetadata,
	manifest: { path: string; data: PackageManifest },
	cwd: string,
) {
	const ownerVersion = manifest.data.version
	const supportedRange = pkg.peerDependencies?.[metadata.owner]
	if (!ownerVersion || !supportedRange) return
	if (supportedRange.startsWith('workspace:')) return

	const semver = await import('semver')
	if (!semver.valid(ownerVersion) || !semver.validRange(supportedRange)) return
	if (semver.satisfies(ownerVersion, supportedRange)) return

	throw new OfficialCapabilityError({
		code: 'PLUXEL_CAPABILITY_OWNER_INCOMPATIBLE',
		owner: metadata.owner,
		subpath: metadata.subpath,
		cwd,
		message: [
			`The \`pluxel ${metadata.command}\` command resolved ${metadata.owner}@${ownerVersion}, but @pluxel/cli@${pkg.version} supports ${supportedRange}.`,
			`Use a compatible project-local @pluxel/cli or update ${metadata.owner}.`,
			`Resolved owner manifest: ${manifest.path}`,
		].join('\n'),
	})
}

function ownerMissingError(
	metadata: OfficialCapabilityMetadata,
	cwd: string,
	cause: unknown,
): OfficialCapabilityError {
	return new OfficialCapabilityError({
		code: 'PLUXEL_CAPABILITY_OWNER_MISSING',
		owner: metadata.owner,
		subpath: metadata.subpath,
		cwd,
		cause,
		message: [
			`The \`pluxel ${metadata.command}\` command requires the optional ${metadata.owner} package.`,
			`Install it in this project with \`${metadata.install}\`.`,
			`Dependency resolution base: ${cwd}`,
		].join('\n'),
	})
}

function subpathMissingError(
	metadata: OfficialCapabilityMetadata,
	manifest: { path: string; data: PackageManifest },
	cwd: string,
	cause: unknown,
): OfficialCapabilityError {
	const ownerVersion = manifest.data.version ? `@${manifest.data.version}` : ''
	return new OfficialCapabilityError({
		code: 'PLUXEL_CAPABILITY_SUBPATH_MISSING',
		owner: metadata.owner,
		subpath: metadata.subpath,
		cwd,
		cause,
		message: [
			`Resolved ${metadata.owner}${ownerVersion}, but public entry ${formatOwnerSubpath(metadata)} is missing.`,
			'Reinstall the package or use mutually compatible @pluxel/cli and owner versions.',
			`Resolved owner manifest: ${manifest.path}`,
		].join('\n'),
	})
}

function importFailedError(
	metadata: OfficialCapabilityMetadata,
	resolvedImport: string,
	cwd: string,
	cause: unknown,
): OfficialCapabilityError {
	const reason = cause instanceof Error ? cause.message : String(cause)
	return new OfficialCapabilityError({
		code: 'PLUXEL_CAPABILITY_IMPORT_FAILED',
		owner: metadata.owner,
		subpath: metadata.subpath,
		cwd,
		cause,
		message: [
			`Failed to load ${formatOwnerSubpath(metadata)} from ${resolvedImport}.`,
			`Dependency resolution base: ${cwd}`,
			`Cause: ${reason}`,
		].join('\n'),
	})
}

function formatOwnerSubpath(metadata: OfficialCapabilityMetadata): string {
	return metadata.subpath === '.'
		? metadata.owner
		: `${metadata.owner}/${metadata.subpath.slice(2)}`
}

function getStartupCwd(): string {
	const value = (globalThis as Record<symbol, unknown>)[STARTUP_CWD_SYMBOL]
	return typeof value === 'string' && value ? value : process.cwd()
}

function readPackageManifest(source: string, path: string): PackageManifest {
	const parsed = JSON.parse(source) as unknown
	if (!parsed || typeof parsed !== 'object') {
		throw new TypeError(`Invalid package manifest: ${path}`)
	}
	return parsed as PackageManifest
}
