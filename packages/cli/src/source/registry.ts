import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, normalize, resolve } from 'pathe'
import {
	normalizeRepositoryIdentity,
	readSourceCheckoutRegistry,
	type SourceCheckoutRegistry,
} from './config'

export function resolveSourceCheckouts(registryPath: string, moduleUrl = import.meta.url) {
	const registered = readSourceCheckoutRegistry(registryPath).checkouts
	const implicit = discoverCliCheckout(moduleUrl)
	const checkouts = { ...implicit, ...registered }
	return Object.entries(checkouts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([repository, root]) => ({
			repository,
			root,
			origin: Object.hasOwn(registered, repository) ? ('registered' as const) : ('cli' as const),
		}))
}

/** Recognize only this CLI's source checkout, never the caller's enclosing repository. */
function discoverCliCheckout(moduleUrl: string): Record<string, string> {
	let directory = dirname(realpathSync(fileURLToPath(moduleUrl)))
	while (!existsSync(resolve(directory, 'package.json'))) {
		const parent = dirname(directory)
		if (parent === directory) return {}
		directory = parent
	}
	const cli = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
	if (cli.name !== '@pluxel/cli') return {}
	const root = resolve(directory, '../..')
	if (
		directory !== resolve(root, 'packages/cli') ||
		!existsSync(resolve(root, '.git')) ||
		!existsSync(resolve(root, 'pnpm-workspace.yaml')) ||
		!existsSync(resolve(directory, 'src/cli.ts')) ||
		!existsSync(resolve(root, 'package.json'))
	)
		return {}
	const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
	if (manifest.name !== 'pluxel' || manifest.private !== true) return {}
	const repository =
		typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
	if (
		!repository ||
		normalizeRepositoryIdentity(repository) !== 'https://github.com/PluxelJS/pluxel'
	)
		return {}
	return { [normalizeRepositoryIdentity(repository)]: normalize(root) }
}

export function unregisterSourceCheckout(options: {
	registryPath: string
	repository: string
}): boolean {
	const repository = normalizeRepositoryIdentity(options.repository)
	const registry = readSourceCheckoutRegistry(options.registryPath)
	if (!Object.hasOwn(registry.checkouts, repository)) return false
	delete registry.checkouts[repository]
	writeRegistryAtomic(options.registryPath, registry)
	return true
}

export function registerSourceCheckout(options: {
	registryPath: string
	repository: string
	checkoutRoot: string
}): SourceCheckoutRegistry {
	const repository = normalizeRepositoryIdentity(options.repository)
	const checkoutRoot = normalize(resolve(options.checkoutRoot))
	const registry = readSourceCheckoutRegistry(options.registryPath)
	const next: SourceCheckoutRegistry = {
		version: 1,
		checkouts: Object.fromEntries(
			Object.entries({ ...registry.checkouts, [repository]: checkoutRoot }).sort(([a], [b]) =>
				a.localeCompare(b),
			),
		),
	}
	writeRegistryAtomic(options.registryPath, next)
	return next
}

function writeRegistryAtomic(path: string, registry: SourceCheckoutRegistry) {
	mkdirSync(dirname(path), { recursive: true })
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
	try {
		writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, {
			encoding: 'utf8',
			mode: 0o600,
		})
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
}
