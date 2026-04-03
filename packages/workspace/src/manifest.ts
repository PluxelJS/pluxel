import { readFileSync, writeFileSync } from 'node:fs'
import { resolve as r } from 'pathe'
import type { PackageJson } from 'pkg-types'
import { nodeWorkspaceFs, readTextFile, type WorkspaceFs } from './fs'

export async function safeReadManifest(dir: string): Promise<PackageJson | undefined> {
	return await safeReadManifestWithFs(dir, nodeWorkspaceFs)
}

export async function safeReadManifestWithFs(
	dir: string,
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<PackageJson | undefined> {
	const manifestPath = r(dir, 'package.json')
	if (!fs.existsSync(manifestPath)) return undefined
	try {
		return JSON.parse(await readTextFile(fs, manifestPath)) as PackageJson
	} catch {
		return undefined
	}
}

export function manifestPathFor(dir: string): string | undefined {
	return manifestPathForWithFs(dir, nodeWorkspaceFs)
}

export function manifestPathForWithFs(
	dir: string,
	fs: WorkspaceFs = nodeWorkspaceFs,
): string | undefined {
	const path = r(dir, 'package.json')
	return fs.existsSync(path) ? path : undefined
}

export function readRawManifest(path: string): { data: PackageJson; raw: string } {
	const raw = readFileSync(path, 'utf8')
	const data = JSON.parse(raw) as PackageJson
	return { data, raw }
}

export function writeManifest(path: string, manifest: PackageJson, original?: string) {
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
