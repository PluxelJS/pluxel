import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

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
				if (!provider || isPublishablePackage(provider)) continue
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

export async function readRepositoryPackages(root = repositoryRoot) {
	const packagesDirectory = resolve(root, 'packages')
	const pluginsDirectory = resolve(root, 'plugins')
	const projectRoots = await childDirectories(resolve(root, 'projects'))
	const packageRootGroups = await Promise.all(
		[resolve(root, 'apps'), packagesDirectory].map(packageDirectories),
	)
	const packageRoots = packageRootGroups.flat()
	const pluginDirectories = await childDirectories(pluginsDirectory)
	const pluginRootGroups = await Promise.all(
		pluginDirectories.map(async (directory) =>
			(await hasPackageManifest(directory)) ? [directory] : packageDirectories(directory),
		),
	)
	const pluginRoots = pluginRootGroups.flat()
	const candidateRoots = [
		root,
		resolve(root, 'web'),
		...projectRoots,
		resolve(root, 'projects/embedded-launcher/sdk'),
		...packageRoots,
		...pluginRoots,
	]
	const roots = []
	for (const directory of candidateRoots) {
		if (await hasPackageManifest(directory)) roots.push(directory)
	}

	return await Promise.all(
		roots.map(async (packageRoot) => {
			const manifestPath = resolve(packageRoot, 'package.json')
			const kind =
				packageRoot === root
					? 'root'
					: packageRoot.startsWith(`${pluginsDirectory}${sep}`)
						? 'plugin'
						: packageRoot.startsWith(`${packagesDirectory}${sep}`)
							? 'package'
							: 'project'
			return {
				packageRoot,
				manifestPath,
				directory: relative(root, packageRoot).replaceAll(sep, '/'),
				kind,
				manifest: JSON.parse(await readFile(manifestPath, 'utf8')),
			}
		}),
	)
}

async function childDirectories(directory) {
	try {
		const entries = await readdir(directory, { withFileTypes: true })
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => resolve(directory, entry.name))
	} catch (error) {
		if (error?.code === 'ENOENT') return []
		throw error
	}
}

async function packageDirectories(directory) {
	const packages = []
	for (const child of await childDirectories(directory)) {
		if (await hasPackageManifest(child)) packages.push(child)
	}
	return packages
}

async function hasPackageManifest(directory) {
	try {
		await readFile(resolve(directory, 'package.json'))
		return true
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return false
		throw error
	}
}

export const repositoryPackages = await readRepositoryPackages()
