import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from 'yaml'

import { isPublishablePackage, repositoryPackages } from './repository-packages.mjs'
import { paper } from './tegami.mts'

const root = resolve(import.meta.dirname, '..')
const repositoryUrl = 'https://github.com/PluxelJS/pluxel'
const expectedLicense = 'AGPL-3.0-only'
const sourcePeerRange = 'workspace:^'
const dependencyFields = [
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
]
const errors = []

const packageManifests = repositoryPackages
const rootManifest = packageManifests.find(({ kind }) => kind === 'root')?.manifest
if (!rootManifest) throw new Error('repository package inventory is missing the root package')
const rootLicense = await readFile(resolve(root, 'LICENSE'), 'utf8')
const miseConfig = await readFile(resolve(root, 'mise.toml'), 'utf8')
const pnpmLock = await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8')

for (const [tool, requiredMajor] of [
	['node', 24],
	['pnpm', 11],
]) {
	const configured = new RegExp(`^${tool}\\s*=\\s*["']([^"']+)["']`, 'm').exec(miseConfig)?.[1]
	if (!isSemver(configured)) {
		errors.push(`mise.toml ${tool} must pin an exact semver, got ${configured}`)
		continue
	}
	const major = Number(configured.split('.')[0])
	if (tool === 'node' && major < requiredMajor) {
		errors.push(`mise.toml node must be at least major ${requiredMajor}, got ${configured}`)
	}
	if (tool === 'pnpm' && major !== requiredMajor) {
		errors.push(`mise.toml pnpm must stay on major ${requiredMajor}, got ${configured}`)
	}
}
if (/^bun\s*=/m.test(miseConfig)) {
	errors.push('mise.toml must not configure Bun; repository scripts use Node.js')
}
if (rootManifest.repository?.url !== repositoryUrl) {
	errors.push(`root repository.url must be ${repositoryUrl}`)
}
if (rootManifest.license !== expectedLicense) {
	errors.push(`root package license must be ${expectedLicense}`)
}
if (rootManifest.packageManager !== undefined) {
	errors.push('use devEngines.packageManager instead of a version-pinned packageManager field')
}
if (!isSemver(rootManifest.devDependencies?.tegami)) {
	errors.push('root devDependencies.tegami must pin an exact semver')
}
const packageManager = rootManifest.devEngines?.packageManager
if (packageManager?.name !== 'pnpm') {
	errors.push('devEngines.packageManager.name must be pnpm')
}
if (typeof packageManager?.version !== 'string' || isSemver(packageManager.version)) {
	errors.push(
		'devEngines.packageManager.version must be a non-exact range; mise controls the installed pnpm version',
	)
}
if (packageManager?.onFail !== 'ignore') {
	errors.push(
		'devEngines.packageManager.onFail must be ignore; mise selects pnpm while npm handles trusted publishing',
	)
}
if (/^\s+packageManagerDependencies:/m.test(pnpmLock)) {
	errors.push(
		'pnpm-lock.yaml must not pin pnpm; mise controls the installed package manager version',
	)
}
if (rootManifest.workspaces !== undefined) {
	errors.push(
		'package.json#workspaces duplicates pnpm-workspace.yaml; keep one workspace authority',
	)
}
if (Object.keys(rootManifest.dependencies ?? {}).length > 0) {
	errors.push('the root package must not own runtime dependencies; declare them in each consumer')
}

const workspaceSource = await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
const workspace = parse(workspaceSource)
const workspacePatterns = new Set(workspace.packages)
for (const pattern of ['packages/*', 'plugins/*', 'plugins/*/*']) {
	if (!workspacePatterns.has(pattern)) errors.push(`workspace is missing ${pattern}`)
}
if ((await isDirectory(resolve(root, 'apps'))) && !workspacePatterns.has('apps/*')) {
	errors.push('workspace is missing apps/*')
}
if (await isDirectory(resolve(root, 'projects'))) {
	if (!workspacePatterns.has('projects/*')) errors.push('workspace is missing projects/*')
}

const catalogNames = new Set(Object.keys(workspace.catalog ?? {}))
if (catalogNames.size === 0) errors.push('pnpm-workspace.yaml must define a default catalog')

const packageNames = packageManifests.map(({ manifest }) => manifest.name).filter(Boolean)
if (new Set(packageNames).size !== packageNames.length) {
	errors.push('repository package names must be unique')
}
const publicPackages = packageManifests.filter(isPublishablePackage)
const publicVersions = new Map(
	publicPackages.map(({ manifest }) => [manifest.name, manifest.version]),
)
if (publicPackages.length === 0) errors.push('no public packages found under packages/ or plugins/')

const releaseDraft = await paper.draft()
const plannedPackages = []
const plannedTypes = new Map()
for (const [id, draft] of releaseDraft.getPackageDrafts()) {
	if (draft.type === undefined) continue
	const name = id.startsWith('npm:') ? id.slice('npm:'.length) : id
	plannedPackages.push(name)
	plannedTypes.set(name, draft.type)
	if (!publicVersions.has(name)) errors.push(`Tegami planned non-public package ${name}`)
}

const preOnePackages = publicPackages.filter(({ manifest }) => manifest.version.startsWith('0.'))
if (preOnePackages.length > 0) {
	if (preOnePackages.length !== publicPackages.length) {
		errors.push('initial public release must move every public package to 1.0.0 atomically')
	}
	for (const { manifest } of publicPackages) {
		if (plannedTypes.get(manifest.name) !== 'major') {
			errors.push(`${manifest.name} must have a major Tegami intent for the initial 1.0.0 release`)
		}
	}
}

for (const { packageRoot, manifestPath, directory, kind, manifest } of packageManifests) {
	const isPublic = isPublishablePackage({ kind, manifest })
	if (typeof manifest.scripts?.typecheck !== 'string' || manifest.scripts.typecheck.length === 0) {
		errors.push(`${relative(manifestPath)}: every workspace package must define a typecheck script`)
	}
	if (
		Object.values(manifest.scripts ?? {}).some((script) =>
			/(?:^|\s)node\s+--test(?:\s|$)/.test(script),
		)
	) {
		errors.push(`${relative(manifestPath)}: test scripts must use Vitest instead of node --test`)
	}
	for (const field of dependencyFields) {
		for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
			if (catalogNames.has(name) && specifier !== 'catalog:') {
				errors.push(`${relative(manifestPath)}: ${field}.${name} must use catalog:`)
			}
			if (specifier === 'catalog:' && !catalogNames.has(name)) {
				errors.push(`${relative(manifestPath)}: ${field}.${name} is missing from the catalog`)
			}

			if (!isPublic || !publicVersions.has(name)) continue
			if (field === 'peerDependencies') {
				const publishedPeerRange = `^${publicVersions.get(name)}`
				if (specifier !== sourcePeerRange && specifier !== publishedPeerRange) {
					errors.push(
						`${manifest.name} peerDependencies.${name} must be ${sourcePeerRange} in source or ${publishedPeerRange} in a packed manifest, got ${specifier}`,
					)
				}
				if (manifest.devDependencies?.[name] !== 'workspace:*') {
					errors.push(
						`${manifest.name} must provide peer ${name} through devDependencies.${name}=workspace:* for repository development`,
					)
				}
				continue
			}
			if (field === 'devDependencies' && specifier === 'workspace:*') continue
			const syncVersion = manifest.name === '@pluxel/create' && name === '@pluxel/cli'
			const expectedSourceRange = syncVersion ? 'workspace:*' : 'workspace:^'
			const expectedPublishedRange = syncVersion
				? publicVersions.get(name)
				: `^${publicVersions.get(name)}`
			if (specifier === expectedSourceRange || specifier === expectedPublishedRange) continue
			errors.push(
				`${manifest.name} ${field}.${name} must be ${expectedSourceRange} in source or ${expectedPublishedRange} in a packed manifest, got ${specifier}`,
			)
		}
	}

	if (isPublic) {
		if (!isSemver(manifest.version)) {
			errors.push(`${manifest.name} version must be valid semver, got ${manifest.version}`)
		}
		if (manifest.license !== expectedLicense) {
			errors.push(`${manifest.name} license must be ${expectedLicense}`)
		}
		if ((await readOptionalFile(resolve(packageRoot, 'LICENSE'))) !== rootLicense) {
			errors.push(`${manifest.name} must include an unmodified package-local LICENSE`)
		}
		if (manifest.repository?.url !== repositoryUrl) {
			errors.push(`${manifest.name} repository.url must be ${repositoryUrl}`)
		}
		if (manifest.repository?.directory !== directory) {
			errors.push(`${manifest.name} repository.directory must be ${directory}`)
		}
	}

	if (kind === 'plugin') {
		for (const field of ['dependencies', 'optionalDependencies']) {
			for (const name of Object.keys(manifest[field] ?? {})) {
				if (name.startsWith('@pluxel/')) {
					errors.push(
						`${relative(manifestPath)}: Plugin package ${field}.${name} must be a peer dependency to preserve host Plugin identity`,
					)
				}
			}
		}
		for (const [name, specifier] of Object.entries(manifest.peerDependencies ?? {})) {
			if (!name.startsWith('@pluxel/')) continue
			if (specifier !== 'workspace:^') {
				errors.push(`${relative(manifestPath)}: peerDependencies.${name} must be workspace:^`)
			}
			if (manifest.devDependencies?.[name] !== 'workspace:*') {
				errors.push(`${relative(manifestPath)}: peer ${name} must have a workspace:* devDependency`)
			}
		}
	}
}

const reusablePackageSources = await Promise.all(
	packageManifests
		.filter(({ kind }) => kind === 'package')
		.map(async ({ packageRoot }) => ({
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
	console.error(`Repository governance failed:\n- ${errors.join('\n- ')}`)
	process.exitCode = 1
} else {
	console.info(
		`Repository governance passed for ${packageManifests.length} package roots, ${publicPackages.length} public packages, ${plannedPackages.length} currently planned`,
	)
}

function isSemver(version) {
	return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
		String(version),
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

async function readOptionalFile(path) {
	try {
		return await readFile(path, 'utf8')
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined
		throw error
	}
}

function relative(path) {
	return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}
