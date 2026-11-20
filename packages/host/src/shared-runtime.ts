import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Fixed framework interoperability boundaries. This is not a package-sharing registry. */
export const sharedRuntimes = {
	workbenchCapnweb: {
		name: 'capnweb',
		marker: 'workbenchCapnweb',
		label: 'capnweb',
		host: 'capnweb',
		owner: '@pluxel/host',
		entry: '@pluxel/host',
	},
	tinybase: {
		name: 'tinybase',
		marker: 'tinybase',
		label: 'TinyBase',
		host: 'Core',
		owner: '@pluxel/core',
		entry: '@pluxel/core',
	},
} as const

export type SharedRuntime = (typeof sharedRuntimes)[keyof typeof sharedRuntimes]

export interface SharedRuntimePackage {
	manifestPath: string
	owner: string
	peer: unknown
	peerVersion: string | undefined
	dev: unknown
	devVersion: string | undefined
	marker: unknown
}

/** The importing package's peer is an explicit interoperability declaration, even before build. */
export function readSharedRuntimePackage(
	importer: string,
	runtime: SharedRuntime,
): SharedRuntimePackage | undefined {
	const manifestPath = nearestPackageManifest(importer)
	if (!manifestPath) return undefined
	const manifest = readPackageManifest(manifestPath)
	const peer = recordField(manifest, 'peerDependencies')?.[runtime.name]
	const dev = recordField(manifest, 'devDependencies')?.[runtime.name]
	return {
		manifestPath,
		owner: stringField(manifest, 'name') ?? manifestPath,
		peer,
		peerVersion: declaredVersion(peer, manifestPath, runtime.name),
		dev,
		devVersion: declaredVersion(dev, manifestPath, runtime.name),
		marker: recordField(manifest, 'pluxel')?.[runtime.marker],
	}
}

export function participatesInSharedRuntime(owner: SharedRuntimePackage | undefined): boolean {
	return !!owner && (owner.peer !== undefined || owner.marker !== undefined)
}

/** Validate declarations and installed bytes before rebinding any original import. */
export function assertSharedRuntimeAdmission(input: {
	runtime: SharedRuntime
	package: SharedRuntimePackage
	supportedVersion: string
	actualVersion: string | undefined
	actualEntry: string | undefined
	development: boolean
	operation: string
}): void {
	const {
		runtime,
		package: owner,
		supportedVersion,
		actualVersion,
		actualEntry,
		development,
		operation,
	} = input
	if (runtime.name === 'tinybase' && owner.owner === runtime.owner) {
		assertSharedRuntimeHost({
			...input,
			manifestPath: owner.manifestPath,
		})
		return
	}
	if (
		owner.peerVersion === supportedVersion &&
		(!development || owner.devVersion === supportedVersion) &&
		(owner.marker === undefined || owner.marker === supportedVersion) &&
		actualVersion === supportedVersion
	)
		return
	throw new Error(
		`[${operation}] ${runtime.label} admission failed for ${owner.owner} (${owner.manifestPath}): ` +
			`peerDependencies.${runtime.name} ${String(owner.peer ?? '<missing>')}` +
			(development ? `, devDependencies.${runtime.name} ${String(owner.dev ?? '<missing>')}` : '') +
			(owner.marker !== undefined ? `, pluxel.${runtime.marker} ${String(owner.marker)}` : '') +
			`; resolved ${actualVersion ?? '<missing>'} at ${actualEntry ?? '<missing>'}; ` +
			`Host ${runtime.host} supports ${supportedVersion}. Update this package's peer${development ? '/dev' : ''} declaration and installation, then rerun the check.`,
	)
}

export function installedSharedRuntimeVersion(entry: string, runtime: SharedRuntime): string {
	const manifestPath = nearestPackageManifest(entry)
	if (!manifestPath) throw new Error(`Cannot identify installed ${runtime.name} from ${entry}`)
	const manifest = readPackageManifest(manifestPath)
	const version = exactVersion(manifest.version)
	if (manifest.name !== runtime.name || !version)
		throw new Error(`Cannot identify installed ${runtime.name} from ${entry} (${manifestPath})`)
	return version
}

/** Core owns the exact managed-state dependency; its installed copy must match that policy. */
export function admitSharedRuntimeOwner(
	ownerEntry: string,
	runtimeEntry: string,
	runtime: SharedRuntime,
	operation: string,
): string {
	const installed = installedSharedRuntimeVersion(runtimeEntry, runtime)
	if (runtime.name !== 'tinybase') return installed
	const manifestPath = nearestPackageManifest(ownerEntry)
	if (!manifestPath)
		throw new Error(`[${operation}] Cannot identify Core TinyBase owner from ${ownerEntry}`)
	const manifest = readPackageManifest(manifestPath)
	if (manifest.name !== runtime.owner)
		throw new Error(`[${operation}] Expected ${runtime.owner} at ${manifestPath}`)
	const dependency = recordField(manifest, 'dependencies')?.[runtime.name]
	const supportedVersion = declaredVersion(dependency, manifestPath, runtime.name)
	if (!supportedVersion)
		throw new Error(
			`[${operation}] ${runtime.owner} must declare an exact dependencies.${runtime.name} at ${manifestPath}`,
		)
	assertSharedRuntimeHost({
		runtime,
		manifestPath,
		supportedVersion,
		actualVersion: installed,
		actualEntry: runtimeEntry,
		operation,
	})
	return supportedVersion
}

/** The runtime owner declares its exact ordinary dependency. */
export function assertSharedRuntimeHost(input: {
	runtime: SharedRuntime
	manifestPath: string
	supportedVersion: string
	actualVersion: string | undefined
	actualEntry: string | undefined
	operation: string
}): void {
	const { runtime, manifestPath, supportedVersion, actualVersion, actualEntry, operation } = input
	const manifest = readPackageManifest(manifestPath)
	const dependency = recordField(manifest, 'dependencies')?.[runtime.name]
	if (
		declaredVersion(dependency, manifestPath, runtime.name) === supportedVersion &&
		actualVersion === supportedVersion
	)
		return
	throw new Error(
		`[${operation}] Host ${runtime.label} admission failed for ${String(manifest.name ?? manifestPath)} (${manifestPath}): ` +
			`dependencies.${runtime.name} ${String(dependency ?? '<missing>')}; resolved ${actualVersion ?? '<missing>'} at ${actualEntry ?? '<missing>'}; ` +
			`Host ${runtime.host} supports ${supportedVersion}. Install this exact version as a direct dependency of ${runtime.owner}.`,
	)
}

/** Only native runtime imports need admission; importing Core alone adds no TinyBase peer. */
export function sharedRuntimeForImport(specifier: string): SharedRuntime | undefined {
	if (specifier === 'capnweb') return sharedRuntimes.workbenchCapnweb
	if (specifier === 'tinybase' || specifier.startsWith('tinybase/')) return sharedRuntimes.tinybase
	return undefined
}

export function nearestPackageManifest(file: string): string | undefined {
	let directory = dirname(resolve(file.split('?', 1)[0]!))
	for (;;) {
		const manifestPath = join(directory, 'package.json')
		if (selectedFileExists(manifestPath)) return manifestPath
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

function selectedFileExists(path: string): boolean {
	try {
		lstatSync(path)
		return true
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return false
		throw new Error(`[shared-runtime] Cannot inspect ${path}`, { cause })
	}
}

export function declaredVersion(
	value: unknown,
	packageJsonPath: string,
	name: string,
): string | undefined {
	if (typeof value !== 'string') return undefined
	if (!value.startsWith('catalog:')) return exactVersion(value)
	let directory = dirname(resolve(packageJsonPath))
	for (;;) {
		const workspaceFile = join(directory, 'pnpm-workspace.yaml')
		if (selectedFileExists(workspaceFile)) {
			let source: string
			try {
				source = readFileSync(workspaceFile, 'utf8')
			} catch (cause) {
				throw new Error(`[shared-runtime] Cannot read workspace catalog ${workspaceFile}`, {
					cause,
				})
			}
			let workspace: unknown
			try {
				workspace = parseYaml(source) as unknown
			} catch (cause) {
				throw new Error(`[shared-runtime] Cannot parse workspace catalog ${workspaceFile}`, {
					cause,
				})
			}
			if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace))
				throw new TypeError(
					`[shared-runtime] Invalid workspace catalog ${workspaceFile}: expected a mapping`,
				)
			const catalogName = value.slice('catalog:'.length)
			const catalog = catalogName
				? recordField(recordField(workspace, 'catalogs'), catalogName)
				: recordField(workspace, 'catalog')
			return exactVersion(catalog?.[name])
		}
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

function exactVersion(value: unknown): string | undefined {
	return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
		? value
		: undefined
}

export function readPackageManifest(path: string): Record<string, unknown> {
	let source: string
	try {
		source = readFileSync(path, 'utf8')
	} catch (cause) {
		throw new Error(`[shared-runtime] Cannot read package manifest ${path}`, { cause })
	}
	let value: unknown
	try {
		value = JSON.parse(source) as unknown
	} catch (cause) {
		throw new Error(`[shared-runtime] Invalid JSON in package manifest ${path}`, { cause })
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError(`[shared-runtime] Invalid package manifest ${path}: expected an object`)
	return value as Record<string, unknown>
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
	const field =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)[key]
			: undefined
	return field && typeof field === 'object' && !Array.isArray(field)
		? (field as Record<string, unknown>)
		: undefined
}

function stringField(value: unknown, key: string): string | undefined {
	const field =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)[key]
			: undefined
	return typeof field === 'string' ? field : undefined
}
