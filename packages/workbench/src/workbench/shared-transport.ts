import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface WorkbenchCapnwebPackage {
	manifestPath: string
	owner: string
	peer: unknown
	peerVersion: string | undefined
	dev: unknown
	devVersion: string | undefined
	marker: unknown
}

/** The nearest package is the owner of an import; a peer also identifies source libraries without a build marker. */
export function readWorkbenchCapnwebPackage(importer: string): WorkbenchCapnwebPackage | undefined {
	const manifestPath = nearestPackageManifest(importer)
	if (!manifestPath) return undefined
	const manifest = readPackageManifest(manifestPath)
	const peer = recordField(manifest, 'peerDependencies')?.capnweb
	const dev = recordField(manifest, 'devDependencies')?.capnweb
	return {
		manifestPath,
		owner: stringField(manifest, 'name') ?? manifestPath,
		peer,
		peerVersion: declaredVersion(peer, manifestPath),
		dev,
		devVersion: declaredVersion(dev, manifestPath),
		marker: recordField(manifest, 'pluxel')?.workbenchCapnweb,
	}
}

/** A declaration and an installed module are different facts; check both before sharing the Host constructor. */
export function assertWorkbenchCapnwebAdmission(input: {
	package: WorkbenchCapnwebPackage
	supportedVersion: string
	actualVersion: string | undefined
	actualEntry: string | undefined
	development: boolean
	operation: string
}): void {
	const {
		package: owner,
		supportedVersion,
		actualVersion,
		actualEntry,
		development,
		operation,
	} = input
	const markerValid = owner.marker === undefined || owner.marker === supportedVersion
	if (
		owner.peerVersion === supportedVersion &&
		(!development || owner.devVersion === supportedVersion) &&
		markerValid &&
		actualVersion === supportedVersion
	)
		return
	throw new Error(
		`[${operation}] Workbench capnweb admission failed for ${owner.owner} (${owner.manifestPath}): ` +
			`peerDependencies.capnweb ${String(owner.peer ?? '<missing>')}` +
			(development ? `, devDependencies.capnweb ${String(owner.dev ?? '<missing>')}` : '') +
			(owner.marker !== undefined ? `, pluxel.workbenchCapnweb ${String(owner.marker)}` : '') +
			`; resolved ${actualVersion ?? '<missing>'} at ${actualEntry ?? '<missing>'}; ` +
			`Host Workbench supports ${supportedVersion}. Update this package's peer${development ? '/dev' : ''} declaration and installation, then rerun the check.`,
	)
}

export async function installedWorkbenchCapnwebVersion(entry: string): Promise<string> {
	const manifestPath = nearestPackageManifest(entry)
	if (!manifestPath) throw new Error(`Cannot identify installed capnweb from ${entry}`)
	const manifest = readPackageManifest(manifestPath)
	const version = exactVersion(manifest.version)
	if (manifest.name !== 'capnweb' || !version)
		throw new Error(`Cannot identify installed capnweb from ${entry} (${manifestPath})`)
	return version
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
		if (isMissingFile(cause)) return false
		throw new Error(`[workbench-capnweb] Cannot inspect ${path}`, { cause })
	}
}

function isMissingFile(cause: unknown): boolean {
	return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}

function declaredVersion(value: unknown, packageJsonPath: string): string | undefined {
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
				throw new Error(`[workbench-capnweb] Cannot read workspace catalog ${workspaceFile}`, {
					cause,
				})
			}
			let workspace: unknown
			try {
				workspace = parseYaml(source) as unknown
			} catch (cause) {
				throw new Error(`[workbench-capnweb] Cannot parse workspace catalog ${workspaceFile}`, {
					cause,
				})
			}
			if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace))
				throw new TypeError(
					`[workbench-capnweb] Invalid workspace catalog ${workspaceFile}: expected a mapping`,
				)
			const catalogName = value.slice('catalog:'.length)
			const catalog = catalogName
				? recordField(recordField(workspace, 'catalogs'), catalogName)
				: recordField(workspace, 'catalog')
			return exactVersion(catalog?.capnweb)
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
		throw new Error(`[workbench-capnweb] Cannot read package manifest ${path}`, { cause })
	}
	let value: unknown
	try {
		value = JSON.parse(source) as unknown
	} catch (cause) {
		throw new Error(`[workbench-capnweb] Invalid JSON in package manifest ${path}`, { cause })
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError(`[workbench-capnweb] Invalid package manifest ${path}: expected an object`)
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
