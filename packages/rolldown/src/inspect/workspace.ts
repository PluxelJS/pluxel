import { glob, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { extractPackageWorkspaces, parsePnpmWorkspace } from '../workspace/info.ts'
import type { WorkspacePackageJson } from '../workspace/package-json.ts'

export type InspectionPackage = Readonly<{
	root: string
	manifestPath: string
	manifest: WorkspacePackageJson
	/** Exact bytes decoded as UTF-8 and used to parse manifest. */
	source: string
}>

export class InspectionWorkspaceError extends Error {
	constructor(
		readonly code:
			| 'invalid_input'
			| 'project_not_found'
			| 'package_not_found'
			| 'ambiguous_package'
			| 'analysis_unavailable',
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'InspectionWorkspaceError'
	}
}

type DiscoveryOptions = { readonly signal?: AbortSignal }
function checkSignal(options: DiscoveryOptions): void {
	options.signal?.throwIfAborted()
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function workspacePatterns(source: string, file: string): readonly string[] {
	const lines = source.split(/\r?\n/)
	const start = lines.findIndex((line) => /^\s*(?:packages|'packages'|"packages")\s*:/.test(line))
	if (start < 0) return []
	if (!/^packages\s*:\s*$/.test(lines[start]!)) {
		throw new InspectionWorkspaceError(
			'analysis_unavailable',
			`Unsupported packages declaration: ${file}`,
		)
	}
	for (const line of lines.slice(start + 1)) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue
		if (/^\S/.test(line)) {
			if (line.startsWith('-'))
				throw new InspectionWorkspaceError(
					'analysis_unavailable',
					`Unsupported unindented workspace list: ${file}`,
				)
			break
		}
		// Match the shared parser's supported block-list grammar explicitly. YAML expressions
		// must never silently become an empty workspace or an incorrect literal directory.
		if (!/^\s+-\s+(?:'[^']+'|"[^"\\]+"|[^'"#{}[\]&*!][^#{}[\]&]*?)\s*$/.test(line)) {
			throw new InspectionWorkspaceError(
				'analysis_unavailable',
				`Unsupported workspace pattern: ${file}`,
			)
		}
	}
	return parsePnpmWorkspace(
		lines.filter((line) => !line.trimStart().startsWith('#')).join('\n'),
	).map((pattern) => pattern.trim())
}

async function readManifest(root: string): Promise<InspectionPackage | undefined> {
	const manifestPath = join(root, 'package.json')
	let source: string
	try {
		source = await readFile(manifestPath, 'utf8')
	} catch (error) {
		if (isMissing(error)) return undefined
		throw error
	}
	let value: unknown
	try {
		value = JSON.parse(source)
	} catch (cause) {
		throw new InspectionWorkspaceError('analysis_unavailable', `Invalid JSON: ${manifestPath}`, {
			cause,
		})
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new InspectionWorkspaceError('analysis_unavailable', `Invalid manifest: ${manifestPath}`)
	}
	const manifest = value as WorkspacePackageJson
	if (manifest.name !== undefined && typeof manifest.name !== 'string') {
		throw new InspectionWorkspaceError(
			'analysis_unavailable',
			`Invalid package name: ${manifestPath}`,
		)
	}
	if (manifest.workspaces !== undefined) {
		const workspaces = Array.isArray(manifest.workspaces)
			? manifest.workspaces
			: manifest.workspaces?.packages
		if (!Array.isArray(workspaces) || workspaces.some((item) => typeof item !== 'string')) {
			throw new InspectionWorkspaceError(
				'analysis_unavailable',
				`Invalid workspaces: ${manifestPath}`,
			)
		}
	}
	return { root, manifestPath, manifest, source }
}

/** Reads declared workspace members only; directory naming never establishes membership. */
export async function discoverPackages(
	root: string,
	options: DiscoveryOptions = {},
): Promise<readonly InspectionPackage[]> {
	checkSignal(options)
	let canonicalRoot: string
	try {
		canonicalRoot = await realpath(root)
		const rootStat = await stat(canonicalRoot)
		if (!rootStat.isDirectory()) throw new Error('Not a directory')
	} catch (cause) {
		throw new InspectionWorkspaceError(
			'project_not_found',
			`Project directory not found: ${root}`,
			{
				cause,
			},
		)
	}
	const rootPackage = await readManifest(canonicalRoot)
	checkSignal(options)
	const patterns = new Set(extractPackageWorkspaces(rootPackage?.manifest))
	try {
		const file = join(canonicalRoot, 'pnpm-workspace.yaml')
		const source = await readFile(file, 'utf8')
		for (const pattern of workspacePatterns(source, file)) patterns.add(pattern)
	} catch (error) {
		if (!isMissing(error)) throw error
	}
	for (const pattern of patterns) {
		const path = pattern.replace(/^!/, '').replaceAll('\\', '/')
		if (
			!path.trim() ||
			isAbsolute(path) ||
			/^[A-Za-z]:/.test(path) ||
			path.split('/').includes('..')
		) {
			throw new InspectionWorkspaceError(
				'analysis_unavailable',
				`Workspace patterns must remain inside the project root: ${pattern}`,
			)
		}
	}
	checkSignal(options)
	const packages = new Map<string, InspectionPackage>()
	if (rootPackage) packages.set(canonicalRoot, rootPackage)
	const include = [...patterns].filter((pattern) => !pattern.startsWith('!'))
	const exclude = [...patterns]
		.filter((pattern) => pattern.startsWith('!'))
		.map((pattern) => `${pattern.slice(1).replace(/\/$/, '')}/**`)
	if (include.length > 0) {
		for await (const file of glob(
			include.map((pattern) => `${pattern.replace(/\/$/, '')}/package.json`),
			{
				cwd: canonicalRoot,
				exclude: ['**/node_modules/**', '**/.git/**', ...exclude],
			},
		)) {
			checkSignal(options)
			if (packages.size >= 4096)
				throw new InspectionWorkspaceError(
					'analysis_unavailable',
					'Workspace discovery exceeds 4096 packages. Select a narrower project root.',
				)
			const packageRoot = await realpath(dirname(resolve(canonicalRoot, file)))
			if (packages.has(packageRoot)) continue
			const found = await readManifest(packageRoot)
			checkSignal(options)
			if (found) packages.set(packageRoot, found)
		}
	}
	const result = [...packages.values()].sort((a, b) => a.root.localeCompare(b.root))
	const names = new Map<string, string>()
	for (const item of result) {
		const name = item.manifest.name
		if (!name) continue
		const previous = names.get(name)
		if (previous) {
			throw new InspectionWorkspaceError(
				'ambiguous_package',
				`Package ${name} has multiple workspace roots: ${previous}, ${item.root}`,
			)
		}
		names.set(name, item.root)
	}
	return result
}

/** Resolves installed package roots without loading an entry or requiring a package.json export. */
export async function resolveInspectionPackage(
	root: string,
	packageName: string,
	packages: readonly InspectionPackage[],
	options: DiscoveryOptions = {},
): Promise<InspectionPackage> {
	checkSignal(options)
	if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(packageName)) {
		throw new InspectionWorkspaceError('invalid_input', `Expected a package name: ${packageName}`)
	}
	const matches = packages.filter((item) => item.manifest.name === packageName)
	if (matches.length > 1) {
		throw new InspectionWorkspaceError(
			'ambiguous_package',
			`Multiple packages named ${packageName}`,
		)
	}
	if (matches[0]) return matches[0]
	const directories: string[] = []
	let parent = resolve(root)
	for (;;) {
		directories.push(join(parent, 'node_modules'))
		const next = dirname(parent)
		if (next === parent) break
		parent = next
	}
	for (const directory of directories) {
		checkSignal(options)
		let packageRoot: string
		try {
			packageRoot = await realpath(join(directory, packageName))
		} catch (error) {
			if (isMissing(error)) continue
			throw error
		}
		const found = await readManifest(packageRoot)
		checkSignal(options)
		if (found) return found
	}
	throw new InspectionWorkspaceError(
		'package_not_found',
		`Package not found from ${root}: ${packageName}`,
	)
}
