import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const rootPath = root.pathname
const repositoryUrl = 'https://github.com/PluxelJS/pluxel'
const expectedLicense = 'AGPL-3.0-only'
const dependencyFields = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
	'devDependencies',
]

const rootPackage = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const rootLicense = await readFile(new URL('LICENSE', root), 'utf8')
const miseConfig = await readFile(new URL('mise.toml', root), 'utf8')
const packages = await readPublicPackages()
const publicVersions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]))
const errors = []

if (packages.length === 0) errors.push('No public packages found under packages/ or plugins/.')

const expectedTools = { node: 'lts', pnpm: 'latest' }
for (const [tool, expected] of Object.entries(expectedTools)) {
	const configured = new RegExp(`^${tool}\\s*=\\s*["']([^"']+)["']`, 'm').exec(miseConfig)?.[1]
	if (configured !== expected) {
		errors.push(`mise.toml ${tool} must use the rolling ${expected} alias, got ${configured}.`)
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
			if (field === 'peerDependencies' && typeof range === 'string' && range.length > 0) continue
			if (range === 'workspace:*' || range === publicVersions.get(name)) continue
			errors.push(
				`${manifest.name} ${field}.${name} must be workspace:* in source or ` +
					`${publicVersions.get(name)} in a packed manifest, got ${range}.`,
			)
		}
	}
}

if (errors.length > 0) {
	for (const error of errors) console.error(error)
	process.exitCode = 1
} else {
	console.log(`Release invariants OK: ${packages.length} independently versioned public packages.`)
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
