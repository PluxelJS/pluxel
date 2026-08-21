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
if (rootManifest.devDependencies?.pncat === undefined) {
	errors.push('the root package must install pncat as the workspace catalog manager')
}
for (const [name, command] of Object.entries({
	'catalog:add': 'pncat add',
	'catalog:check': 'pncat detect --yes',
	'catalog:clean': 'pncat clean --yes',
	'catalog:migrate': 'pncat migrate --force --yes',
})) {
	if (rootManifest.scripts?.[name] !== command) {
		errors.push(`package.json#scripts.${name} must be ${JSON.stringify(command)}`)
	}
}
if (!(await isFile(resolve(root, 'pncat.config.ts')))) {
	errors.push('workspace is missing pncat.config.ts')
}

const workspaceSource = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
for (const pattern of ['packages/*', 'plugins/*']) {
	if (!workspaceSource.includes(`- ${pattern}`)) errors.push(`workspace is missing ${pattern}`)
}
if (!workspaceSource.includes('- host')) {
	errors.push('workspace is missing host')
}
if (!workspaceSource.includes('- host/web')) errors.push('workspace is missing host/web')
if ((await isDirectory(resolve(root, 'apps'))) && !workspaceSource.includes('- apps/*')) {
	errors.push('workspace is missing apps/*')
}
if (await isDirectory(resolve(root, 'projects'))) {
	for (const pattern of ['projects/*']) {
		if (!workspaceSource.includes(`- ${pattern}`)) errors.push(`workspace is missing ${pattern}`)
	}
}

const catalogEntries = parseCatalogEntries(workspaceSource)
if (catalogEntries.size === 0) errors.push('pnpm-workspace.yaml must define catalogs')

const projectRoots = await childDirectories(resolve(root, 'projects'))
const packageContainers = [resolve(root, 'apps'), resolve(root, 'packages')]
const packageContainerChildren = await Promise.all(packageContainers.map(childDirectories))
const pluginRoots = await childDirectories(resolve(root, 'plugins'))
const pluginPackageRoots = await Promise.all(
	pluginRoots.map(async (directory) =>
		(await isFile(resolve(directory, 'package.json'))) ? [directory] : childDirectories(directory),
	),
)
const candidateRoots = [
	resolve(root, 'host'),
	resolve(root, 'host/web'),
	...projectRoots,
	...packageContainerChildren.flat(),
	...pluginPackageRoots.flat(),
]
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
			const catalogName = catalogEntries.get(name)
			const expectedSpecifier = catalogName && catalogSpecifier(catalogName)
			if (expectedSpecifier && specifier !== expectedSpecifier) {
				errors.push(`${relative(manifestPath)}: ${field}.${name} must use ${expectedSpecifier}`)
			}
			if (specifier.startsWith('catalog:') && !catalogName) {
				errors.push(`${relative(manifestPath)}: ${field}.${name} is missing from the catalog`)
			}
		}
	}
}

const reusablePackageChildren = await Promise.all([resolve(root, 'packages')].map(childDirectories))
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

function parseCatalogEntries(source) {
	const entries = new Map()
	let section
	let catalogName
	for (const line of source.split(/\r?\n/)) {
		if (line === 'catalog:') {
			section = 'catalog'
			catalogName = 'default'
			continue
		}
		if (line === 'catalogs:') {
			section = 'catalogs'
			catalogName = undefined
			continue
		}
		if (!section) continue
		if (line !== '' && !line.startsWith('  ')) {
			section = undefined
			catalogName = undefined
			continue
		}
		if (section === 'catalogs') {
			const group = line.match(/^  ([^:'"\s]+):\s*$/)
			if (group) {
				catalogName = group[1]
				continue
			}
		}
		const indentation = section === 'catalog' ? '  ' : '    '
		const match = line.match(new RegExp(`^${indentation}(?:'([^']+)'|"([^"]+)"|([^:]+)):\\s`))
		const packageName = match?.[1] ?? match?.[2] ?? match?.[3]
		if (packageName && catalogName) {
			if (entries.has(packageName)) throw new Error(`duplicate catalog entry: ${packageName}`)
			entries.set(packageName, catalogName)
		}
	}
	return entries
}

function catalogSpecifier(name) {
	return name === 'default' ? 'catalog:' : `catalog:${name}`
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
