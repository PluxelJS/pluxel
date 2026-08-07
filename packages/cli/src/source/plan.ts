import { existsSync } from 'node:fs'
import { relative, resolve } from 'pathe'
import {
	normalizeRepositoryIdentity,
	readSourceCheckoutRegistry,
	readSourceProjectConfig,
	SOURCE_CONFIG_FILE,
	tryReadSourceProjectConfig,
} from './config'
import {
	collectManifestDependencyNames,
	scanSourceWorkspace,
	type ScannedSourceWorkspace,
	type SourceWorkspacePackage,
} from './workspace'

export interface ResolvedSourceCheckout {
	repository: string
	root: string
	workspace: ScannedSourceWorkspace
	sources: string[]
	singletons: string[]
}

export interface SourceWorkspacePlan {
	root: string
	configPath: string
	registryPath: string
	checkouts: ResolvedSourceCheckout[]
	selectedPackages: SourceWorkspacePackage[]
	selectedByRepository: Map<string, SourceWorkspacePackage[]>
	overrides: Record<string, string>
}

export async function createSourceWorkspacePlan(options: {
	root: string
	configPath?: string
	registryPath: string
}): Promise<SourceWorkspacePlan> {
	const root = resolve(options.root)
	const configPath = options.configPath ?? SOURCE_CONFIG_FILE
	const config = readSourceProjectConfig(root, configPath)
	const registry = readSourceCheckoutRegistry(options.registryPath)
	const checkouts = new Map<string, ResolvedSourceCheckout>()
	const visiting = new Set<string>()

	const loadCheckout = async (repository: string): Promise<void> => {
		const normalized = normalizeRepositoryIdentity(repository)
		if (checkouts.has(normalized)) return
		if (visiting.has(normalized)) {
			throw new Error(`Source repository cycle includes ${normalized}`)
		}
		const checkoutRoot = registry.checkouts[normalized]
		if (!checkoutRoot) {
			throw new Error(
				`Source checkout is not registered: ${normalized}\nRun \`pluxel source register <path>\`.`,
			)
		}
		if (!existsSync(checkoutRoot)) {
			throw new Error(`Registered source checkout does not exist: ${normalized} -> ${checkoutRoot}`)
		}
		visiting.add(normalized)
		const nested = tryReadSourceProjectConfig(checkoutRoot)
		for (const dependency of nested?.sources ?? []) await loadCheckout(dependency)
		const workspace = await scanSourceWorkspace(checkoutRoot)
		checkouts.set(normalized, {
			repository: normalized,
			root: checkoutRoot,
			workspace,
			sources: nested?.sources ?? [],
			singletons: nested?.singletons ?? [],
		})
		visiting.delete(normalized)
	}

	for (const repository of config.sources) await loadCheckout(repository)

	const consumer = await scanSourceWorkspace(root)
	const resolvedCheckouts = [...checkouts.values()]
	const { owners: packageOwners, selected } = selectSourcePackages(consumer, resolvedCheckouts)

	const selectedByRepository = new Map<string, SourceWorkspacePackage[]>()
	for (const pkg of selected.values()) {
		const owner = packageOwners.get(pkg.name)!.checkout.repository
		const list = selectedByRepository.get(owner) ?? []
		list.push(pkg)
		selectedByRepository.set(owner, list)
	}
	for (const list of selectedByRepository.values()) {
		list.sort((a, b) => a.name.localeCompare(b.name))
	}

	const overrides = Object.fromEntries(
		[...selected.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((pkg) => [pkg.name, `link:${normalizeLinkPath(pkg.dir)}`]),
	)
	for (const singleton of config.singletons) {
		overrides[singleton] = resolveSingletonOverride(
			singleton,
			resolvedCheckouts,
			new Set(selected.keys()),
		)
	}

	return {
		root,
		configPath: resolve(root, configPath),
		registryPath: options.registryPath,
		checkouts: resolvedCheckouts,
		selectedPackages: [...selected.values()].sort((a, b) => a.name.localeCompare(b.name)),
		selectedByRepository,
		overrides,
	}
}

export function sourceCheckoutInstallOverrides(
	checkout: ResolvedSourceCheckout,
	plan: SourceWorkspacePlan,
) {
	if (checkout.sources.length === 0) return {}
	const providers = collectSourceClosure(checkout.sources, plan.checkouts)
	const { selected } = selectSourcePackages(checkout.workspace, providers)
	const output = Object.fromEntries(
		[...selected.values()].map((pkg) => [pkg.name, `link:${normalizeLinkPath(pkg.dir)}`]),
	)
	for (const singleton of checkout.singletons) {
		output[singleton] = resolveSingletonOverride(singleton, providers, new Set(selected.keys()))
	}
	return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b)))
}

export function describeSourcePath(root: string, path: string) {
	const rel = relative(root, path).replaceAll('\\', '/')
	return rel && !rel.startsWith('../') ? rel : path
}

function normalizeLinkPath(path: string) {
	return resolve(path).replaceAll('\\', '/')
}

function resolveSingletonOverride(
	name: string,
	checkouts: ResolvedSourceCheckout[],
	selectedPackages: Set<string>,
) {
	const owners = checkouts.flatMap((checkout) =>
		checkout.workspace.packages.filter(
			(pkg) =>
				selectedPackages.has(pkg.name) && Object.hasOwn(pkg.manifest.dependencies ?? {}, name),
		),
	)
	if (owners.length !== 1) {
		throw new Error(
			`Singleton ${name} must have exactly one direct source dependency owner; found ${owners.length}` +
				(owners.length > 0 ? ` (${owners.map((owner) => owner.name).join(', ')})` : ''),
		)
	}
	return `link:${normalizeLinkPath(resolve(owners[0]!.dir, 'node_modules', name))}`
}

function selectSourcePackages(
	consumer: ScannedSourceWorkspace,
	checkouts: ResolvedSourceCheckout[],
) {
	const owners = new Map<
		string,
		{ checkout: ResolvedSourceCheckout; pkg: SourceWorkspacePackage }
	>()
	for (const checkout of checkouts) {
		for (const pkg of checkout.workspace.packages) {
			const existing = owners.get(pkg.name)
			if (existing) {
				throw new Error(
					`Source package ${pkg.name} is provided by both ${existing.checkout.repository} and ${checkout.repository}`,
				)
			}
			owners.set(pkg.name, { checkout, pkg })
		}
	}

	const consumerPackageNames = new Set(consumer.packages.map((pkg) => pkg.name))
	const requested = new Set<string>()
	for (const pkg of consumer.packages) {
		for (const name of collectManifestDependencyNames(pkg.manifest, { includeDev: true })) {
			requested.add(name)
		}
	}
	if (consumer.packages.every((pkg) => pkg.dir !== consumer.root)) {
		for (const name of collectManifestDependencyNames(consumer.rootManifest, {
			includeDev: true,
		})) {
			requested.add(name)
		}
	}

	const selected = new Map<string, SourceWorkspacePackage>()
	const queue = [...requested]
	while (queue.length > 0) {
		const name = queue.shift()!
		if (consumerPackageNames.has(name)) continue
		const owned = owners.get(name)
		if (!owned || selected.has(name)) continue
		selected.set(name, owned.pkg)
		for (const dependency of collectManifestDependencyNames(owned.pkg.manifest, {
			includeDev: false,
		})) {
			queue.push(dependency)
		}
	}
	if (selected.size === 0) {
		throw new Error(
			`Source workspace ${consumer.root} does not depend on any package provided by its declared sources`,
		)
	}
	return { owners, selected }
}

function collectSourceClosure(repositories: string[], checkouts: ResolvedSourceCheckout[]) {
	const byRepository = new Map(checkouts.map((checkout) => [checkout.repository, checkout]))
	const included = new Set<string>()
	const visit = (repository: string) => {
		const normalized = normalizeRepositoryIdentity(repository)
		if (included.has(normalized)) return
		const checkout = byRepository.get(normalized)
		if (!checkout) throw new Error(`Missing resolved source checkout: ${normalized}`)
		included.add(normalized)
		for (const source of checkout.sources) visit(source)
	}
	for (const repository of repositories) visit(repository)
	return checkouts.filter((checkout) => included.has(checkout.repository))
}
