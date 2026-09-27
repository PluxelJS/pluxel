import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { resolveWithOxc } from '../resolver/oxc'

const IMPORT_CONDITIONS = { conditionNames: ['node', 'import', 'default'] } as const

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
export async function readWorkbenchCapnwebPackage(importer: string): Promise<WorkbenchCapnwebPackage | undefined> {
	const manifestPath = nearestManifest(importer)
	if (!manifestPath) return undefined
	const manifest = await readJson(manifestPath)
	const peer = recordField(manifest, 'peerDependencies')?.capnweb
	const dev = recordField(manifest, 'devDependencies')?.capnweb
	return {
		manifestPath,
		owner: stringField(manifest, 'name') ?? manifestPath,
		peer,
		peerVersion: await declaredVersion(peer, manifestPath),
		dev,
		devVersion: await declaredVersion(dev, manifestPath),
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
	const { package: owner, supportedVersion, actualVersion, actualEntry, development, operation } = input
	const markerValid = owner.marker === undefined || owner.marker === supportedVersion
	if (
		owner.peerVersion === supportedVersion &&
		(!development || owner.devVersion === supportedVersion) &&
		markerValid &&
		actualVersion === supportedVersion
	) return
	throw new Error(
		`[${operation}] Workbench capnweb admission failed for ${owner.owner} (${owner.manifestPath}): ` +
		`peerDependencies.capnweb ${String(owner.peer ?? '<missing>')}` +
		(development ? `, devDependencies.capnweb ${String(owner.dev ?? '<missing>')}` : '') +
		(owner.marker !== undefined ? `, pluxel.workbenchCapnweb ${String(owner.marker)}` : '') +
		`; resolved ${actualVersion ?? '<missing>'} at ${actualEntry ?? '<missing>'}; ` +
		`Host Workbench supports ${supportedVersion}. Update this package's peer${development ? '/dev' : ''} declaration and installation, then rerun the check.`,
	)
}

/** Source builds require a development copy; installed publishers require only their published peer. */
export async function validateWorkbenchCapnwebPeer(packageJsonPath: string): Promise<string> {
	const owner = await readWorkbenchCapnwebPackage(join(dirname(packageJsonPath), '__entry__.mjs'))
	if (!owner || owner.manifestPath !== resolve(packageJsonPath))
		throw new Error(`[pluxel:build] Cannot read Workbench publisher manifest ${packageJsonPath}`)
	const workbench = resolveWithOxc(dirname(packageJsonPath), '@pluxel/workbench', IMPORT_CONDITIONS)
	if (!workbench) throw new Error(`[pluxel:build] Cannot resolve @pluxel/workbench from ${packageJsonPath}`)
	const canonical = resolveWithOxc(dirname(workbench.path), 'capnweb', IMPORT_CONDITIONS)
	if (!canonical) throw new Error(`[pluxel:build] Cannot resolve Workbench capnweb from ${workbench.path}`)
	const supportedVersion = await installedWorkbenchCapnwebVersion(canonical.path)
	const actual = resolveWithOxc(dirname(packageJsonPath), 'capnweb', IMPORT_CONDITIONS)
	const actualVersion = actual ? await installedWorkbenchCapnwebVersion(actual.path) : undefined
	assertWorkbenchCapnwebAdmission({
		package: owner,
		supportedVersion,
		actualVersion,
		actualEntry: actual?.path,
		development: true,
		operation: 'pluxel:build',
	})
	return supportedVersion
}

export async function installedWorkbenchCapnwebVersion(entry: string): Promise<string> {
	const manifestPath = nearestManifest(entry)
	if (!manifestPath) throw new Error(`Cannot identify installed capnweb from ${entry}`)
	const manifest = await readJson(manifestPath)
	const version = exactVersion(manifest.version)
	if (manifest.name !== 'capnweb' || !version)
		throw new Error(`Cannot identify installed capnweb from ${entry} (${manifestPath})`)
	return version
}

function nearestManifest(file: string): string | undefined {
	let directory = dirname(resolve(file.split('?', 1)[0]!))
	for (;;) {
		const manifestPath = join(directory, 'package.json')
		if (existsSync(manifestPath)) return manifestPath
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

async function declaredVersion(value: unknown, packageJsonPath: string): Promise<string | undefined> {
	if (typeof value !== 'string') return undefined
	if (!value.startsWith('catalog:')) return exactVersion(value)
	let directory = dirname(resolve(packageJsonPath))
	for (;;) {
		const workspaceFile = join(directory, 'pnpm-workspace.yaml')
		if (existsSync(workspaceFile)) {
			const workspace = parseYaml(await readFile(workspaceFile, 'utf8')) as unknown
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

async function readJson(path: string): Promise<Record<string, unknown>> {
	const value = JSON.parse(await readFile(path, 'utf8')) as unknown
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError(`[workbench-capnweb] Invalid package manifest ${path}`)
	return value as Record<string, unknown>
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
	const field = value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined
	return field && typeof field === 'object' && !Array.isArray(field)
		? field as Record<string, unknown>
		: undefined
}

function stringField(value: unknown, key: string): string | undefined {
	const field = value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined
	return typeof field === 'string' ? field : undefined
}
