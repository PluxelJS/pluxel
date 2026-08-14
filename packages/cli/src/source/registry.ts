import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, normalize, resolve } from 'pathe'
import {
	normalizeRepositoryIdentity,
	readSourceCheckoutRegistry,
	type SourceCheckoutRegistry,
} from './config'

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
