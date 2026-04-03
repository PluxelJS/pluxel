import { normalize, resolve as r } from 'pathe'
import type { PackageJson } from 'pkg-types'
import { nodeWorkspaceFs, readTextFile, type WorkspaceFs } from './fs'
import { manifestPathForWithFs, safeReadManifestWithFs } from './manifest'

export interface WorkspaceInfo {
	root: string
	manifest?: PackageJson
	manifestPath?: string
	patterns: string[]
	packageDirs: string[]
	isMonorepo: boolean
}

export async function loadWorkspaceInfo(root: string): Promise<WorkspaceInfo> {
	return await loadWorkspaceInfoWithFs(root, nodeWorkspaceFs)
}

export async function loadWorkspaceInfoWithFs(
	root: string,
	fs: WorkspaceFs = nodeWorkspaceFs,
): Promise<WorkspaceInfo> {
	const manifest = await safeReadManifestWithFs(root, fs)
	const manifestPath = manifestPathForWithFs(root, fs)

	const patterns = new Set<string>()
	for (const p of extractPackageWorkspaces(manifest)) {
		patterns.add(p)
	}

	const pnpmWorkspacePath = r(root, 'pnpm-workspace.yaml')
	if (fs.existsSync(pnpmWorkspacePath)) {
		for (const p of parsePnpmWorkspace(await readTextFile(fs, pnpmWorkspacePath))) {
			patterns.add(p)
		}
	}

	const explicitPatterns = patterns.size > 0
	if (!explicitPatterns) {
		patterns.add('packages/*')
		patterns.add('apps/*')
	}

	const packageDirs = await collectPackageDirsWithFs(root, [...patterns], fs)
	const isMonorepo = explicitPatterns || packageDirs.length > 0

	const info: WorkspaceInfo = {
		root: normalize(root),
		patterns: [...patterns],
		packageDirs,
		isMonorepo,
	}
	if (manifest) info.manifest = manifest
	if (manifestPath) info.manifestPath = manifestPath
	return info
}

export function extractPackageWorkspaces(pkg: PackageJson | undefined): string[] {
	if (!pkg) return []
	const raw = (pkg as any).workspaces
	if (!raw) return []
	if (Array.isArray(raw)) return raw
	if (Array.isArray(raw?.packages)) return raw.packages
	return []
}

async function collectPackageDirsWithFs(
	root: string,
	patterns: string[],
	fs: WorkspaceFs,
): Promise<string[]> {
	const out = new Set<string>()
	for (const pattern of patterns) {
		const m = pattern.replace(/\/\*\*?$/, '/*').match(/^(.*)\/\*$/)
		if (!m) continue
		const base = r(root, m[1])
		try {
			const list = await fs.promises.readdir(base, { withFileTypes: true })
			for (const entry of list) {
				if (!entry.isDirectory?.()) continue
				const pkgDir = r(base, entry.name)
				if (fs.existsSync(r(pkgDir, 'package.json'))) {
					out.add(normalize(pkgDir))
				}
			}
		} catch {
			// ignore missing directories
		}
	}
	return [...out]
}

export function parsePnpmWorkspace(contents: string): string[] {
	const lines = contents.split(/\r?\n/)
	const res: string[] = []
	let inPk = false
	let indent = 0

	for (const raw of lines) {
		const line = raw.replace(/\t/g, '  ')
		if (!inPk) {
			const match = line.match(/^(\s*)packages\s*:\s*$/)
			if (match) {
				inPk = true
				indent = match[1].length
			}
			continue
		}
		if (line.trim() && line.match(new RegExp(`^\\\\s{0,${indent}}\\\\S`))) break
		const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/)
		if (match) res.push(match[1])
	}

	return res
}
