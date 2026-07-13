import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const packagesDirectory = new URL('../packages/', import.meta.url)
const repositoryUrl = 'https://github.com/PluxelJS/pluxel'
const dependencyFields = [
	'dependencies',
	'peerDependencies',
	'optionalDependencies',
	'devDependencies',
]

const rootPackage = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const miseConfig = await readFile(new URL('mise.toml', root), 'utf8')
const packages = await readPublicPackages()
const publicVersions = new Map(packages.map(({ manifest }) => [manifest.name, manifest.version]))
const errors = []

if (packages.length === 0) errors.push('No public packages found under packages/.')

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

	if (manifest.repository?.url !== repositoryUrl) {
		errors.push(`${manifest.name} repository.url must be ${repositoryUrl}.`)
	}

	const expectedDirectory = `packages/${directory}`
	if (manifest.repository?.directory !== expectedDirectory) {
		errors.push(`${manifest.name} repository.directory must be ${expectedDirectory}.`)
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
	const entries = await readdir(packagesDirectory, { withFileTypes: true })
	const publicPackages = []

	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const file = join(packagesDirectory.pathname, entry.name, 'package.json')
		try {
			const manifest = JSON.parse(await readFile(file, 'utf8'))
			if (manifest.private !== true) publicPackages.push({ directory: entry.name, manifest })
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error
		}
	}

	return publicPackages.toSorted((left, right) =>
		left.manifest.name.localeCompare(right.manifest.name),
	)
}
