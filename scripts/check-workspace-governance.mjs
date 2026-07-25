import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dependencyFields = [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
]
const errors = []

const rootManifest = await readJson(resolve(root, 'package.json'))
if (rootManifest.workspaces !== undefined) {
	errors.push(
		'package.json#workspaces duplicates pnpm-workspace.yaml; keep one workspace authority',
	)
}
if (Object.keys(rootManifest.dependencies ?? {}).length > 0) {
	errors.push('the root package must not own runtime dependencies; declare them in each consumer')
}

const workspaceSource = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
for (const pattern of ['packages/*', 'plugins/*']) {
	if (!workspaceSource.includes(`- ${pattern}`)) errors.push(`workspace is missing ${pattern}`)
}
if (await isDirectory(resolve(root, 'projects'))) {
	for (const pattern of [
		'projects/*',
		'projects/*/packages/*',
		'projects/*/platforms/*',
		'projects/*/plugins/*',
	]) {
		if (!workspaceSource.includes(`- ${pattern}`)) errors.push(`workspace is missing ${pattern}`)
	}
}

const catalogNames = parseCatalogNames(workspaceSource)
if (catalogNames.size === 0) errors.push('pnpm-workspace.yaml must define a default catalog')

const projectRoots = await childDirectories(resolve(root, 'projects'))
const packageContainers = [
	resolve(root, 'apps'),
	resolve(root, 'packages'),
	resolve(root, 'plugins'),
	...projectRoots.flatMap((project) => [
		resolve(project, 'packages'),
		resolve(project, 'platforms'),
		resolve(project, 'plugins'),
	]),
]
const packageContainerChildren = await Promise.all(packageContainers.map(childDirectories))
const candidateRoots = [resolve(root, 'web'), ...projectRoots, ...packageContainerChildren.flat()]
const candidatePackageRoots = await Promise.all(
	candidateRoots.map(async (directory) => {
		const hasManifest = await isFile(resolve(directory, 'package.json'))
		return hasManifest ? directory : undefined
	}),
)
const packageRoots = [root, ...candidatePackageRoots.filter(Boolean)]

const packageManifests = await Promise.all(
	packageRoots.map(async (packageRoot) => {
		const manifestPath = resolve(packageRoot, 'package.json')
		return { manifestPath, manifest: await readJson(manifestPath) }
	}),
)
for (const { manifestPath, manifest } of packageManifests) {
	for (const field of dependencyFields) {
		for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
			if (catalogNames.has(name) && specifier !== 'catalog:') {
				errors.push(`${relative(manifestPath)}: ${field}.${name} must use catalog:`)
			}
			if (specifier === 'catalog:' && !catalogNames.has(name)) {
				errors.push(`${relative(manifestPath)}: ${field}.${name} is missing from the catalog`)
			}
		}
	}
}

const reusablePackageChildren = await Promise.all(
	[resolve(root, 'packages'), ...projectRoots.map((project) => resolve(project, 'packages'))].map(
		childDirectories,
	),
)
const reusablePackageRoots = reusablePackageChildren.flat()
const reusablePackageSources = await Promise.all(
	reusablePackageRoots.map(async (packageRoot) => ({
		packageRoot,
		sources: await sourceContents(resolve(packageRoot, 'src')),
	})),
)
for (const { packageRoot, sources } of reusablePackageSources) {
	if (/^\s*@Plugin\s*\(\s*\{/m.test(sources)) {
		errors.push(
			`${relative(packageRoot)} declares a concrete @Plugin; move it to plugins/ or a domain-specific plugin container such as platforms/`,
		)
	}
}

if (errors.length > 0) {
	console.error(`Workspace governance failed:\n- ${errors.join('\n- ')}`)
	process.exitCode = 1
} else {
	console.info(`Workspace governance passed for ${packageRoots.length} package roots`)
}

function parseCatalogNames(source) {
	const names = new Set()
	let inCatalog = false
	for (const line of source.split(/\r?\n/)) {
		if (line === 'catalog:') {
			inCatalog = true
			continue
		}
		if (!inCatalog) continue
		if (line !== '' && !line.startsWith('  ')) break
		const match = line.match(/^  (?:'([^']+)'|"([^"]+)"|([^:]+)):\s/)
		const name = match?.[1] ?? match?.[2] ?? match?.[3]
		if (name) names.add(name)
	}
	return names
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

async function sourceContents(directory) {
	const entries = await childDirectoriesAndFiles(directory)
	const fragments = await Promise.all(
		entries.map(async (entry) => {
			if (entry.kind === 'directory') return sourceContents(entry.path)
			if (
				/\.[cm]?[jt]sx?$/.test(entry.path) &&
				!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.path)
			) {
				return readFile(entry.path, 'utf8')
			}
			return ''
		}),
	)
	return fragments.join('')
}

async function childDirectoriesAndFiles(directory) {
	try {
		const entries = await readdir(directory, { withFileTypes: true })
		return entries.map((entry) => ({
			kind: entry.isDirectory() ? 'directory' : 'file',
			path: resolve(directory, entry.name),
		}))
	} catch (error) {
		if (error?.code === 'ENOENT') return []
		throw error
	}
}

async function isDirectory(path) {
	const siblings = await childDirectories(resolve(path, '..'))
	return siblings.includes(path)
}

async function isFile(path) {
	try {
		await readFile(path)
		return true
	} catch (error) {
		if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return false
		throw error
	}
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'))
}

function relative(path) {
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}
