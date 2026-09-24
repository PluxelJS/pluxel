import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** Admit only packages that actually publish a Workbench RpcTarget. */
export async function validateWorkbenchCapnwebPeer(packageJsonPath: string): Promise<string> {
	const manifest = await readJson(packageJsonPath)
	const owner = stringField(manifest, 'name') ?? packageJsonPath
	const requirePlugin = createRequire(packageJsonPath)
	const workbenchManifestPath = requirePlugin.resolve('@pluxel/workbench/package.json')
	const requireWorkbench = createRequire(workbenchManifestPath)
	const supportedVersion = await installedVersion(requireWorkbench.resolve('capnweb'), 'capnweb')
	const peer = recordField(manifest, 'peerDependencies')?.capnweb
	const dev = recordField(manifest, 'devDependencies')?.capnweb
	const peerVersion = await declaredVersion(peer, packageJsonPath)
	const devVersion = await declaredVersion(dev, packageJsonPath)
	let actualEntry: string | undefined
	try {
		actualEntry = requirePlugin.resolve('capnweb')
	} catch {
		// The missing package is included in the diagnostic below.
	}
	const actualVersion = actualEntry ? await installedVersion(actualEntry, 'capnweb') : undefined
	if (
		peerVersion === supportedVersion &&
		devVersion === supportedVersion &&
		actualVersion === supportedVersion
	)
		return supportedVersion
	throw new Error(
		`[pluxel:build] Workbench target publisher ${owner} requires capnweb peer and dev dependency ${supportedVersion}; declared peer ${String(peer ?? '<missing>')}, dev ${String(dev ?? '<missing>')}, installed ${actualVersion ?? '<missing>'}. Workbench owns the supported capnweb version.`,
	)
}

async function declaredVersion(
	value: unknown,
	packageJsonPath: string,
): Promise<string | undefined> {
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

async function installedVersion(entry: string, name: string): Promise<string> {
	let directory = dirname(entry)
	for (;;) {
		const manifestPath = join(directory, 'package.json')
		if (existsSync(manifestPath)) {
			const manifest = await readJson(manifestPath)
			if (manifest.name === name) {
				const version = exactVersion(manifest.version)
				if (version) return version
			}
		}
		const parent = dirname(directory)
		if (parent === directory) {
			throw new Error(`[pluxel:build] Cannot read installed ${name} version from ${entry}`)
		}
		directory = parent
	}
}

async function readJson(path: string): Promise<Record<string, unknown>> {
	const value = JSON.parse(await readFile(path, 'utf8')) as unknown
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`[pluxel:build] Invalid package manifest ${path}`)
	}
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
