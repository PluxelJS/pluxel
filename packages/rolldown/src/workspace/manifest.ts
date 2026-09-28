import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { nodeWorkspaceFs, readTextFile, type WorkspaceFs } from './fs'
import type { WorkspacePackageJson } from './package-json'

export async function safeReadManifest(dir: string): Promise<WorkspacePackageJson | undefined> {
	return await safeReadManifestWithFs(dir, nodeWorkspaceFs)
}

export async function safeReadManifestWithFs(
	dir: string,
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<WorkspacePackageJson | undefined> {
	const manifestPath = resolve(dir, 'package.json')
	let raw: string
	try {
		raw = await readTextFile(fs, manifestPath)
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return undefined
		throw new Error(`Cannot read package manifest ${manifestPath}`, { cause })
	}
	try {
		const value: unknown = JSON.parse(raw)
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('Expected a JSON object')
		}
		return value as WorkspacePackageJson
	} catch (cause) {
		throw new Error(`Invalid package manifest ${manifestPath}`, { cause })
	}
}

export function manifestPathFor(dir: string): string | undefined {
	return manifestPathForWithFs(dir, nodeWorkspaceFs)
}

export function manifestPathForWithFs(
	dir: string,
	fs: WorkspaceFs = nodeWorkspaceFs,
): string | undefined {
	const path = resolve(dir, 'package.json')
	return fs.existsSync(path) ? path : undefined
}

export function readRawManifest(path: string): { data: WorkspacePackageJson; raw: string } {
	const raw = readFileSync(path, 'utf8')
	const data = JSON.parse(raw) as WorkspacePackageJson
	return { data, raw }
}

export function writeManifest(path: string, manifest: WorkspacePackageJson, original?: string) {
	const indent = detectIndent(original) ?? '\t'
	const contents = `${JSON.stringify(manifest, null, indent)}\n`
	writeFileSync(path, contents, 'utf8')
}

function detectIndent(input?: string) {
	if (!input) return undefined
	const match = input.match(/^[ \t]+(?="\w)/m)
	if (!match) return undefined
	const sample = match[0] ?? ''
	if (!sample) return undefined
	return sample.includes('\t') ? '\t' : ' '.repeat(sample.length)
}
