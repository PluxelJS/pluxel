import { readdir, readFile } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

export const repositoryRoot = resolve(import.meta.dirname, '..')

export function isPublishablePackage({ kind, manifest }) {
	return (kind === 'package' || kind === 'plugin') && manifest.private !== true
}

export function tegamiIgnoredPackageNames(packages) {
	return packages
		.filter((pkg) => !isPublishablePackage(pkg))
		.map(({ manifest }) => manifest.name)
		.filter((name) => typeof name === 'string' && name.length > 0)
		.toSorted()
}

export function packagesRequiringInitialMajor(packages) {
	const preOnePackages = packages.filter(({ manifest }) => manifest.version?.startsWith('0.'))
	return preOnePackages.length === packages.length ? packages : preOnePackages
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
