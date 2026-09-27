import { normalize, resolve } from 'pathe'
import YAML from 'yaml'
import { nodeWorkspaceFs, readTextFile, type WorkspaceFs } from './fs'
import { safeReadManifestWithFs } from './manifest'
import type { WorkspacePackageJson } from './package-json'

export interface WorkspaceInfo {
	root: string
	manifest: WorkspacePackageJson
	manifestPath: string
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
	root = resolve(root)
	const manifest = await safeReadManifestWithFs(root, fs)
	const manifestPath = resolve(root, 'package.json')
	if (!manifest)
		throw new Error(`Workspace root must contain package.json: ${resolve(root, 'package.json')}`)
	if (manifest.workspaces !== undefined)
		throw new Error(`Workspace membership belongs in pnpm-workspace.yaml, not ${manifestPath}`)

	const pnpmWorkspacePath = resolve(root, 'pnpm-workspace.yaml')
	let patterns: string[] = []
	let isMonorepo = false
	let contents: string | undefined
	try {
		contents = await readTextFile(fs, pnpmWorkspacePath)
	} catch (cause) {
		if (!isMissing(cause)) {
			throw new Error(`Cannot read workspace declaration ${pnpmWorkspacePath}`, { cause })
		}
	}
	if (contents !== undefined) {
		isMonorepo = true
		patterns = parsePnpmWorkspace(contents, pnpmWorkspacePath)
	}
	for (const pattern of patterns) validateWorkspacePattern(pattern, pnpmWorkspacePath)
	const packageDirs = await collectPackageDirsWithFs(root, patterns, fs)

	const info: WorkspaceInfo = {
		root: normalize(root),
		patterns,
		packageDirs,
		isMonorepo,
		manifest,
		manifestPath,
	}
	return info
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
			if (matchesAnyWorkspacePattern(relativeWorkspacePath(root, normalized), excludePatterns))
				continue
			const manifest = await safeReadManifestWithFs(normalized, fs)
			if (!manifest) {
				if (!pattern.includes('*')) {
					throw new Error(`Declared workspace member has no package.json: ${normalized}`)
				}
				continue
			}
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
				await walk(resolve(dir, entry.name), index)
			}
			return
		}
		if (segment.includes('*')) {
			const matcher = segmentMatcher(segment)
			for (const entry of await safeReadDirs(fs, dir)) {
				if (!matcher(entry.name)) continue
				await walk(resolve(dir, entry.name), index + 1)
			}
			return
		}

		const next = resolve(dir, segment)
		try {
			const stats = await fs.promises.stat(next)
			if (!stats.isDirectory?.())
				throw new Error(`Declared workspace member path is not a directory: ${next}`)
		} catch (cause) {
			if (isMissing(cause)) {
				if (!normalizedPattern.includes('*')) {
					throw new Error(`Declared workspace member does not exist: ${next}`, { cause })
				}
				return
			}
			throw new Error(`Cannot inspect workspace member path ${next}`, { cause })
		}
		await walk(next, index + 1)
	}

	await walk(root, 0)
	return out
}

async function safeReadDirs(fs: WorkspaceFs, dir: string) {
	try {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true })
		return entries.filter((entry) => entry.isDirectory?.())
	} catch (cause) {
		if (isMissing(cause)) return []
		throw new Error(`Cannot enumerate workspace directory ${dir}`, { cause })
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function validateWorkspacePattern(pattern: string, declarationPath: string): void {
	const path = pattern.startsWith('!') ? pattern.slice(1) : pattern
	const segments = path.replaceAll('\\', '/').split('/')
	if (
		!path.trim() ||
		path.startsWith('/') ||
		/^[A-Za-z]:/.test(path) ||
		segments.includes('..') ||
		/[?[\]]/.test(path)
	) {
		throw new Error(
			`Unsupported workspace pattern ${JSON.stringify(pattern)} in ${declarationPath}; expected a relative path using * or ** within the workspace root`,
		)
	}
}

function normalizeWorkspacePattern(pattern: string): string {
	return pattern
		.trim()
		.replaceAll('\\', '/')
		.replace(/^\.\/+/, '')
		.replace(/\/+$/, '')
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
	const escaped = escapeRegExp(pattern).replaceAll('\\*\\*', '.*').replaceAll('\\*', '[^/]*')
	const re = new RegExp(`^${escaped}$`)
	return (path) => re.test(path)
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[|\\{}()[\]^$+?.*]/g, '\\$&')
}

function shouldSkipGlobDir(name: string): boolean {
	return name === 'node_modules' || name === '.git'
}

export function parsePnpmWorkspace(contents: string, path = 'pnpm-workspace.yaml'): string[] {
	let value: unknown
	try {
		const document = YAML.parseDocument(contents, { uniqueKeys: true })
		if (document.errors.length > 0) throw document.errors[0]
		value = document.toJS()
	} catch (cause) {
		throw new Error(`Invalid workspace declaration ${path}`, { cause })
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Invalid workspace declaration ${path}; expected a YAML mapping`)
	}
	const packages = (value as { packages?: unknown }).packages
	if (packages === undefined) return []
	if (
		!Array.isArray(packages) ||
		packages.some((item) => typeof item !== 'string' || !item.trim())
	) {
		throw new Error(
			`Invalid workspace declaration ${path}: packages must be a list of nonempty patterns`,
		)
	}
	return packages
}
