import { readFile, readdir } from 'node:fs/promises'
import { dirname, relative, resolve } from 'pathe'
import picomatch from 'picomatch'
import YAML from 'yaml'

const IGNORED_DIRECTORY_NAMES = new Set([
	'.git',
	'.hg',
	'.pluxel',
	'.svn',
	'.turbo',
	'coverage',
	'dist',
	'local-projects',
	'node_modules',
])
const MAX_SCANNED_DIRECTORIES = 50_000

export interface SourcePackageManifest {
	name?: string
	version?: string
	private?: boolean
	repository?: string | { type?: string; url?: string; directory?: string }
	packageManager?: string
	main?: string
	module?: string
	types?: string
	bin?: string | Record<string, string>
	browser?: string | Record<string, string | false>
	exports?: unknown
	imports?: unknown
	scripts?: Record<string, string>
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}

export interface SourceWorkspacePackage {
	name: string
	dir: string
	manifestPath: string
	manifest: SourcePackageManifest
}

export interface ScannedSourceWorkspace {
	root: string
	rootManifest: SourcePackageManifest
	packages: SourceWorkspacePackage[]
	packagesByName: Map<string, SourceWorkspacePackage>
}

export async function scanSourceWorkspace(root: string): Promise<ScannedSourceWorkspace> {
	const absoluteRoot = resolve(root)
	const rootManifest = await readManifest(resolve(absoluteRoot, 'package.json'))
	const patterns = await readWorkspacePatterns(absoluteRoot)
	const packageManifestPaths = new Set<string>()
	if (rootManifest.name) packageManifestPaths.add(resolve(absoluteRoot, 'package.json'))
	if (patterns) {
		for (const path of await findWorkspaceManifestPaths(absoluteRoot, patterns)) {
			packageManifestPaths.add(path)
		}
	}

	const packages: SourceWorkspacePackage[] = []
	const packagesByName = new Map<string, SourceWorkspacePackage>()
	for (const manifestPath of [...packageManifestPaths].sort((a, b) => a.localeCompare(b))) {
		const manifest = await readManifest(manifestPath)
		if (!manifest.name) continue
		const existing = packagesByName.get(manifest.name)
		if (existing) {
			throw new Error(
				`Duplicate package name ${manifest.name} in ${existing.manifestPath} and ${manifestPath}`,
			)
		}
		const pkg = { name: manifest.name, dir: dirname(manifestPath), manifestPath, manifest }
		packages.push(pkg)
		packagesByName.set(pkg.name, pkg)
	}

	return { root: absoluteRoot, rootManifest, packages, packagesByName }
}

export function collectManifestDependencyNames(
	manifest: SourcePackageManifest,
	options: { includeDev: boolean },
) {
	const names = new Set<string>()
	const groups = [
		manifest.dependencies,
		manifest.optionalDependencies,
		manifest.peerDependencies,
		options.includeDev ? manifest.devDependencies : undefined,
	]
	for (const group of groups) {
		for (const name of Object.keys(group ?? {})) names.add(name)
	}
	return names
}

export function sourcePackageNeedsBuild(manifest: SourcePackageManifest) {
	if (typeof manifest.scripts?.build !== 'string') return false
	if (typeof manifest.bin === 'string' || Object.keys(manifest.bin ?? {}).length > 0) return true
	const targets = [
		manifest.main,
		manifest.module,
		manifest.types,
		manifest.browser,
		manifest.exports,
		manifest.imports,
	]
	return targets.some(referencesBuildOutput)
}

async function readWorkspacePatterns(root: string): Promise<string[] | undefined> {
	const path = resolve(root, 'pnpm-workspace.yaml')
	let contents: string
	try {
		contents = await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
	const value = YAML.parse(contents) as unknown
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${path}: expected an object`)
	}
	const raw = (value as { packages?: unknown }).packages ?? ['**']
	if (!Array.isArray(raw)) throw new Error(`${path}: packages must be an array`)
	const patterns = raw.map((pattern, index) => {
		if (typeof pattern !== 'string' || !pattern.trim()) {
			throw new Error(`${path}: packages[${index}] must be a non-empty glob`)
		}
		return normalizeRelative(pattern)
	})
	return patterns
}

async function findWorkspaceManifestPaths(root: string, patterns: string[]) {
	const positives = patterns.filter((pattern) => !pattern.startsWith('!'))
	const negatives = patterns
		.filter((pattern) => pattern.startsWith('!'))
		.map((pattern) => pattern.slice(1))
	const include = picomatch(positives.length > 0 ? positives : ['**'], { dot: true })
	const exclude = negatives.length > 0 ? picomatch(negatives, { dot: true }) : undefined
	const found: string[] = []
	const pending = [root]
	let scanned = 0

	while (pending.length > 0) {
		const current = pending.pop()!
		scanned++
		if (scanned > MAX_SCANNED_DIRECTORIES) {
			throw new Error(
				`Source workspace scan exceeded ${MAX_SCANNED_DIRECTORIES} directories: ${root}`,
			)
		}
		const entries = await readdir(current, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!IGNORED_DIRECTORY_NAMES.has(entry.name)) pending.push(resolve(current, entry.name))
				continue
			}
			if (!entry.isFile() || entry.name !== 'package.json') continue
			const packageDir = normalizeRelative(relative(root, current)) || '.'
			if (include(packageDir) && !exclude?.(packageDir)) found.push(resolve(current, entry.name))
		}
	}
	return found
}

async function readManifest(path: string): Promise<SourcePackageManifest> {
	let contents: string
	try {
		contents = await readFile(path, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Missing package manifest: ${path}`, { cause: error })
		}
		throw error
	}
	try {
		const value = JSON.parse(contents) as unknown
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			throw new Error('expected an object')
		}
		return value as SourcePackageManifest
	} catch (error) {
		throw new Error(`${path}: invalid package manifest (${String(error)})`, { cause: error })
	}
}

function normalizeRelative(value: string) {
	return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
}

function referencesBuildOutput(value: unknown): boolean {
	if (typeof value === 'string') {
		const path = value.replaceAll('\\', '/').replace(/^\.\//, '')
		return /^(?:\.output|build|dist|lib|out)(?:\/|$)/.test(path)
	}
	if (Array.isArray(value)) return value.some(referencesBuildOutput)
	if (!value || typeof value !== 'object') return false
	return Object.values(value).some(referencesBuildOutput)
}
