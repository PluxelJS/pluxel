import { glob, readFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'

export const repositoryRoot = resolve(import.meta.dirname, '..')

// Explicit workspace protocols also cover vendor packages outside the release inventory.
export function rootWorkspaceDependencyErrors(manifest, packages) {
	const names = new Set(
		packages.filter(({ kind }) => kind !== 'root').map(({ manifest: entry }) => entry.name),
	)
	const errors = []
	for (const field of [
		'dependencies',
		'devDependencies',
		'optionalDependencies',
		'peerDependencies',
	]) {
		for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
			if (names.has(name) || specifier.startsWith('workspace:')) {
				errors.push(
					`root ${field}.${name} must be owned by its consuming package; declare it in its consumer package`,
				)
			}
		}
	}
	return errors
}

export function isPublishablePackage({ kind, manifest }) {
	return (kind === 'package' || kind === 'plugin') && manifest.private !== true
}

/**
 * Local tarballs needed by a published consumer; development and optional peer links stay external.
 * @param {Awaited<ReturnType<typeof readRepositoryPackages>>} packages
 * @param {readonly string[]} roots
 * @returns {Awaited<ReturnType<typeof readRepositoryPackages>>}
 */
export function publishPackageClosure(packages, roots) {
	const available = new Map(
		packages.filter(isPublishablePackage).map((item) => [item.manifest.name, item]),
	)
	const selected = new Map()
	const pending = [...roots]
	while (pending.length > 0) {
		const name = pending.shift()
		if (selected.has(name)) continue
		const item = available.get(name)
		if (!item) throw new Error(`Local publish package not found: ${name}`)
		selected.set(name, item)
		const { dependencies, optionalDependencies, peerDependencies, peerDependenciesMeta } =
			item.manifest
		for (const dependency of Object.keys({ ...dependencies, ...optionalDependencies })) {
			if (available.has(dependency)) pending.push(dependency)
		}
		for (const dependency of Object.keys(peerDependencies ?? {})) {
			if (available.has(dependency) && peerDependenciesMeta?.[dependency]?.optional !== true) {
				pending.push(dependency)
			}
		}
	}
	return [...selected.values()].sort((left, right) =>
		left.manifest.name.localeCompare(right.manifest.name),
	)
}

export function tegamiIgnorePattern(packages) {
	const names = packages
		.filter(isPublishablePackage)
		.map(({ manifest }) => manifest.name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.toSorted()
	// Tegami tests both bare package names and qualified workspace IDs.
	return new RegExp(`^(?!(?:npm:)?(?:${names.join('|')})$)`)
}

export function packagesRequiringInitialMajor(packages) {
	const preOnePackages = packages.filter(({ manifest }) => manifest.version?.startsWith('0.'))
	return preOnePackages.length === packages.length ? packages : preOnePackages
}

export function releasePackageErrors(packages) {
	const errors = []
	const publicPackages = packages.filter(isPublishablePackage)
	const coreVersion = publicPackages.find(({ manifest }) => manifest.name === '@pluxel/core')
		?.manifest.version
	if (!coreVersion || coreVersion.startsWith('0.'))
		errors.push('@pluxel/core must define the stable public release line')
	for (const { kind, manifest } of packages) {
		if (kind === 'plugin' && !/^@pluxel\/plugin-.+/.test(manifest.name ?? '')) {
			errors.push(`${manifest.name} official Plugin packages must use @pluxel/plugin-xxx names`)
		}
	}
	for (const { manifest } of publicPackages) {
		if (!manifest.version?.startsWith('0.') && manifest.version !== coreVersion) {
			errors.push(
				`${manifest.name} stable version ${manifest.version} must match Core ${coreVersion}`,
			)
		}
	}
	return errors
}

export function workspaceOnlyDependencyErrors(packages) {
	const providers = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]))
	const errors = []
	for (const { manifest, packageRoot } of packages.filter(isPublishablePackage)) {
		for (const field of [
			'dependencies',
			'optionalDependencies',
			'peerDependencies',
			'devDependencies',
		]) {
			for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
				const provider = providers.get(name)
				if (!provider || provider.kind === 'vendor' || isPublishablePackage(provider)) continue
				const developmentLink = `link:${relative(packageRoot, provider.packageRoot).replaceAll(sep, '/')}`
				if (field === 'devDependencies') {
					if (specifier !== developmentLink)
						errors.push(
							`${manifest.name} devDependencies.${name} must be ${developmentLink} for a workspace-only provider`,
						)
				} else if (field === 'peerDependencies') {
					if (specifier !== '*' || manifest.peerDependenciesMeta?.[name]?.optional !== true)
						errors.push(
							`${manifest.name} peerDependencies.${name} must be an optional '*' peer for a workspace-only provider`,
						)
					if (manifest.devDependencies?.[name] !== developmentLink)
						errors.push(
							`${manifest.name} optional workspace-only peer ${name} must have devDependencies.${name}=${developmentLink}`,
						)
				} else {
					errors.push(
						`${manifest.name} ${field}.${name} cannot require a workspace-only provider; use an optional peer integration`,
					)
				}
			}
		}
	}
	return errors
}

// pnpm owns membership; directory names only classify the selected packages.
/**
 * @returns {Promise<Array<{
 *   packageRoot: string,
 *   manifestPath: string,
 *   directory: string,
 *   kind: 'root' | 'package' | 'plugin' | 'project' | 'vendor',
 *   manifest: Record<string, any>
 * }>>}
 */
export async function readRepositoryPackages(root = repositoryRoot) {
	const workspace = parse(await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8'))
	if (
		!Array.isArray(workspace?.packages) ||
		!workspace.packages.every((pattern) => typeof pattern === 'string')
	) {
		throw new Error('pnpm-workspace.yaml must declare a packages array of glob patterns')
	}
	const patterns = [
		'package.json',
		...workspace.packages
			.filter((pattern) => !pattern.startsWith('!'))
			.map((pattern) => `${pattern}/package.json`),
	]
	const exclude = [
		'**/node_modules/**',
		...workspace.packages
			.filter((pattern) => pattern.startsWith('!'))
			.map((pattern) => `${pattern.slice(1)}/**`),
	]
	const paths = await Array.fromAsync(glob(patterns, { cwd: root, exclude }))
	return Promise.all(
		paths.toSorted().map(async (path) => {
			const manifestPath = resolve(root, path)
			const packageRoot = dirname(manifestPath)
			const directory = relative(root, packageRoot).replaceAll(sep, '/')
			const kind =
				directory === ''
					? 'root'
					: directory.startsWith('plugins/')
						? 'plugin'
						: directory.startsWith('packages/')
							? 'package'
							: directory.startsWith('vendor/')
								? 'vendor'
								: 'project'
			return {
				packageRoot,
				manifestPath,
				directory,
				kind,
				manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
			}
		}),
	)
}

export const repositoryPackages = await readRepositoryPackages()
