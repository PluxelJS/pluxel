import { normalize, resolve as r } from 'pathe'
import { nodeWorkspaceFs, readTextFile, type WorkspaceFs } from './fs'
import { manifestPathForWithFs, safeReadManifestWithFs } from './manifest'
import type { WorkspacePackageJson } from './package-json'

export interface WorkspaceInfo {
	root: string
	manifest?: WorkspacePackageJson
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

export function extractPackageWorkspaces(pkg: WorkspacePackageJson | undefined): string[] {
	if (!pkg) return []
	const raw = pkg.workspaces
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
	const includePatterns = patterns.filter((p) => !p.trim().startsWith('!'))
	const excludePatterns = patterns
		.map((p) => p.trim())
		.filter((p) => p.startsWith('!'))
		.map((p) => normalizeWorkspacePattern(p.slice(1)))

	for (const pattern of includePatterns) {
		for (const pkgDir of await expandWorkspacePattern(root, pattern, fs)) {
			const normalized = normalize(pkgDir)
			if (!fs.existsSync(r(normalized, 'package.json'))) continue
			if (matchesAnyWorkspacePattern(relativeWorkspacePath(root, normalized), excludePatterns))
				continue
			out.add(normalized)
		}
	}
	return [...out]
}

async function expandWorkspacePattern(
	root: string,
	pattern: string,
	fs: WorkspaceFs,
): Promise<string[]> {
	const normalizedPattern = normalizeWorkspacePattern(pattern)
	if (!normalizedPattern) return []
	const segments = normalizedPattern.split('/').filter(Boolean)
	const out: string[] = []

	const walk = async (dir: string, index: number): Promise<void> => {
		if (index >= segments.length) {
			out.push(dir)
			return
		}

		const segment = segments[index]!
		if (segment === '.') {
			await walk(dir, index + 1)
			return
		}
		if (segment === '**') {
			await walk(dir, index + 1)
			for (const entry of await safeReadDirs(fs, dir)) {
				if (shouldSkipGlobDir(entry.name)) continue
				await walk(r(dir, entry.name), index)
			}
			return
		}
		if (segment.includes('*')) {
			const matcher = segmentMatcher(segment)
			for (const entry of await safeReadDirs(fs, dir)) {
				if (!matcher(entry.name)) continue
				await walk(r(dir, entry.name), index + 1)
			}
			return
		}

		const next = r(dir, segment)
		if (fs.existsSync(next)) await walk(next, index + 1)
	}

	await walk(root, 0)
	return out
}

async function safeReadDirs(fs: WorkspaceFs, dir: string) {
	try {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true })
		return entries.filter((entry) => entry.isDirectory?.())
	} catch {
		return []
	}
}

function normalizeWorkspacePattern(pattern: string): string {
	return pattern.trim().replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
}

function relativeWorkspacePath(root: string, dir: string): string {
	const normalizedRoot = normalize(root).replaceAll('\\', '/').replace(/\/+$/, '')
	const normalizedDir = normalize(dir).replaceAll('\\', '/')
	return normalizedDir.startsWith(`${normalizedRoot}/`)
		? normalizedDir.slice(normalizedRoot.length + 1)
		: normalizedDir
}

function matchesAnyWorkspacePattern(path: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => globMatcher(pattern)(path))
}

function segmentMatcher(pattern: string): (segment: string) => boolean {
	const re = new RegExp(`^${escapeRegExp(pattern).replaceAll('\\*', '[^/]*')}$`)
	return (segment) => re.test(segment)
}

function globMatcher(pattern: string): (path: string) => boolean {
	const escaped = escapeRegExp(pattern)
		.replaceAll('\\*\\*', '.*')
		.replaceAll('\\*', '[^/]*')
	const re = new RegExp(`^${escaped}$`)
	return (path) => re.test(path)
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.*]/g, '\\$&')
}

function shouldSkipGlobDir(name: string): boolean {
	return name === 'node_modules' || name === '.git'
}

export function parsePnpmWorkspace(contents: string): string[] {
	const lines = contents.split(/\r?\n/)
	const res: string[] = []
	let inPk = false
	let indent = 0

	for (const raw of lines) {
		const line = raw.replaceAll('	', '  ')
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
