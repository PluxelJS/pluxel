import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { paper } from './tegami.mts'

const root = new URL('../', import.meta.url)
const rootPath = root.pathname
const repositoryUrl = 'https://github.com/PluxelJS/pluxel'
const expectedLicense = 'AGPL-3.0-only'
const sourcePeerRange = 'workspace:^'
const dependencyFields = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
	'devDependencies',
]

const rootPackage = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const rootLicense = await readFile(new URL('LICENSE', root), 'utf8')
const miseConfig = await readFile(new URL('mise.toml', root), 'utf8')
const pnpmLock = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')
const packages = await readPublicPackages()
const publicVersions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]))
const releaseDraft = await paper.draft()
const errors = []

if (packages.length === 0) errors.push('No public packages found under packages/ or plugins/.')

const plannedPackages = []
for (const [id, draft] of releaseDraft.getPackageDrafts()) {
	if (draft.type === undefined) continue
	const name = id.startsWith('npm:') ? id.slice('npm:'.length) : id
	plannedPackages.push(name)
	if (!publicVersions.has(name)) errors.push(`Tegami planned non-public package ${name}.`)
}

const minimumNodeMajor = 24
const requiredPnpmMajor = 11
for (const tool of ['node', 'pnpm']) {
	const configured = new RegExp(`^${tool}\\s*=\\s*["']([^"']+)["']`, 'm').exec(miseConfig)?.[1]
	if (!isSemver(configured)) {
		errors.push(`mise.toml ${tool} must pin an exact semver, got ${configured}.`)
		continue
	}
	const major = Number(configured.split('.')[0])
	if (tool === 'node' && major < minimumNodeMajor) {
		errors.push(`mise.toml node must be at least major ${minimumNodeMajor}, got ${configured}.`)
	}
	if (tool === 'pnpm' && major !== requiredPnpmMajor) {
		errors.push(`mise.toml pnpm must stay on major ${requiredPnpmMajor}, got ${configured}.`)
	}
}
if (/^bun\s*=/m.test(miseConfig)) {
	errors.push('mise.toml must not configure Bun; repository scripts use Node.js.')
}

if (rootPackage.repository?.url !== repositoryUrl) {
	errors.push(`Root repository.url must be ${repositoryUrl}.`)
}
if (rootPackage.license !== expectedLicense) {
	errors.push(`Root package license must be ${expectedLicense}.`)
}

if (rootPackage.packageManager !== undefined) {
	errors.push('Use devEngines.packageManager instead of a version-pinned packageManager field.')
}
if (!isSemver(rootPackage.devDependencies?.tegami)) {
	errors.push('Root devDependencies.tegami must pin an exact semver.')
}
const packageManager = rootPackage.devEngines?.packageManager
if (packageManager?.name !== 'pnpm') {
	errors.push('devEngines.packageManager.name must be pnpm.')
}
if (typeof packageManager?.version !== 'string' || isSemver(packageManager.version)) {
	errors.push(
		'devEngines.packageManager.version must be a non-exact range; mise controls the installed pnpm version.',
	)
}
if (packageManager?.onFail !== 'ignore') {
	errors.push(
		'devEngines.packageManager.onFail must be ignore; mise selects pnpm while npm handles trusted publishing.',
	)
}
if (/^\s+packageManagerDependencies:/m.test(pnpmLock)) {
	errors.push(
		'pnpm-lock.yaml must not pin pnpm; mise controls the installed package manager version.',
	)
}

for (const { directory, manifest } of packages) {
	if (!isSemver(manifest.version)) {
		errors.push(`${manifest.name} version must be valid semver, got ${manifest.version}.`)
	}

	if (manifest.license !== expectedLicense) {
		errors.push(`${manifest.name} license must be ${expectedLicense}.`)
	}

	const packageLicense = await readOptionalFile(join(rootPath, directory, 'LICENSE'))
	if (packageLicense !== rootLicense) {
		errors.push(`${manifest.name} must include an unmodified package-local LICENSE.`)
	}

	if (manifest.repository?.url !== repositoryUrl) {
		errors.push(`${manifest.name} repository.url must be ${repositoryUrl}.`)
	}

	if (manifest.repository?.directory !== directory) {
		errors.push(`${manifest.name} repository.directory must be ${directory}.`)
	}

	for (const field of dependencyFields) {
		for (const [name, range] of Object.entries(manifest[field] ?? {})) {
			if (!publicVersions.has(name)) continue
			if (field === 'peerDependencies') {
				const publishedPeerRange = `^${publicVersions.get(name)}`
				if (range !== sourcePeerRange && range !== publishedPeerRange) {
					errors.push(
						`${manifest.name} peerDependencies.${name} must be ${sourcePeerRange} in source or ${publishedPeerRange} in a packed manifest, got ${range}.`,
					)
				}
				if (manifest.devDependencies?.[name] !== 'workspace:*') {
					errors.push(
						`${manifest.name} must provide peer ${name} through devDependencies.${name}=workspace:* for repository development.`,
					)
				}
				continue
			}
			if (field === 'devDependencies' && range === 'workspace:*') continue
			const syncVersion = manifest.name === '@pluxel/create' && name === '@pluxel/cli'
			const expectedSourceRange = syncVersion ? 'workspace:*' : 'workspace:^'
			const expectedPublishedRange = syncVersion
				? publicVersions.get(name)
				: `^${publicVersions.get(name)}`
			if (range === expectedSourceRange || range === expectedPublishedRange) continue
			errors.push(
				`${manifest.name} ${field}.${name} must be ${expectedSourceRange} in source or ` +
					`${expectedPublishedRange} in a packed manifest, got ${range}.`,
			)
		}
	}
}

if (errors.length > 0) {
	for (const error of errors) console.error(error)
	process.exitCode = 1
} else {
	console.log(
		`Release invariants OK: ${packages.length} public packages, ${plannedPackages.length} currently planned.`,
	)
}

function isSemver(version) {
	return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
		String(version),
	)
}

async function readPublicPackages() {
	const publicPackages = []
	const directories = [
		...(await packageDirectories('packages')),
		...(await pluginPackageDirectories()),
	]

	for (const directory of directories) {
		const file = join(rootPath, directory, 'package.json')
		const manifest = JSON.parse(await readFile(file, 'utf8'))
		if (manifest.private !== true) publicPackages.push({ directory, manifest })
	}

	return publicPackages.toSorted((left, right) =>
		left.manifest.name.localeCompare(right.manifest.name),
	)
}

async function packageDirectories(container) {
	const directory = join(rootPath, container)
	const entries = await readdir(directory, { withFileTypes: true })
	const directories = []

	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const child = `${container}/${entry.name}`
		if ((await readOptionalFile(join(rootPath, child, 'package.json'))) !== undefined) {
			directories.push(child)
		}
	}

	return directories
}

async function pluginPackageDirectories() {
	const entries = await readdir(join(rootPath, 'plugins'), { withFileTypes: true })
	const directories = []

	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const direct = `plugins/${entry.name}`
		if ((await readOptionalFile(join(rootPath, direct, 'package.json'))) !== undefined) {
			directories.push(direct)
			continue
		}
		for (const child of await packageDirectories(direct)) directories.push(child)
	}

	return directories
}

async function readOptionalFile(path) {
	try {
		return await readFile(path, 'utf8')
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined
		throw error
	}
}
