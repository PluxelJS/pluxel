import { existsSync } from 'node:fs'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import {
	sourceBuildDefinition,
	sourceBuildArgs,
	sourceCommandDefinition,
	sourceDoctorDefinition,
	sourceInstallDefinition,
	sourceListDefinition,
	sourceUnregisterDefinition,
	sourceRegisterArgs,
	sourceRegisterDefinition,
	sourceWorkspaceArgs,
} from '../command-manifest'
import { normalizeRepositoryIdentity, resolveSourceRegistryPath } from '../source/config'
import {
	buildSourceWorkspace,
	diagnoseSourceWorkspacePlan,
	discoverCheckoutRepository,
	installSourceWorkspace,
} from '../source/execution'
import { createSourceWorkspacePlan, describeSourcePath } from '../source/plan'
import {
	registerSourceCheckout,
	resolveSourceCheckouts,
	unregisterSourceCheckout,
} from '../source/registry'
import { sourcePackageNeedsBuild } from '../source/workspace'

type SourceWorkspaceValues = ArgValues<typeof sourceWorkspaceArgs>
type SourceBuildValues = ArgValues<typeof sourceBuildArgs>
type SourceRegisterValues = ArgValues<typeof sourceRegisterArgs>

export const sourceListCommand = define({
	...sourceListDefinition,
	run(ctx) {
		const registryPath = resolveSourceRegistryPath(ctx.values.registry)
		ctx.log(`registry: ${registryPath}`)
		const checkouts = resolveSourceCheckouts(registryPath)
		if (checkouts.length === 0) ctx.log('No source checkouts. Run `pluxel source register <path>`.')
		for (const checkout of checkouts) {
			ctx.log(
				`${checkout.repository} (${checkout.origin}${existsSync(checkout.root) ? '' : ', missing'})`,
			)
			ctx.log(`  checkout: ${checkout.root}`)
		}
	},
})

export const sourceUnregisterCommand = define({
	...sourceUnregisterDefinition,
	run(ctx) {
		const repository = normalizeRepositoryIdentity(ctx.values.repository)
		const removed = unregisterSourceCheckout({
			registryPath: resolveSourceRegistryPath(ctx.values.registry),
			repository,
		})
		ctx.log(removed ? `Unregistered ${repository}` : `No registration for ${repository}`)
		ctx.log(
			'CLI checkout discovery still applies; run `pluxel source list` to see available sources.',
		)
	},
})

export const sourceRegisterCommand = define({
	...sourceRegisterDefinition,
	async run(ctx) {
		const values = ctx.values as SourceRegisterValues
		const checkoutRoot = resolve(values.checkout || '.')
		if (!existsSync(resolve(checkoutRoot, 'package.json'))) {
			throw new Error(`Source checkout has no package.json: ${checkoutRoot}`)
		}
		const repository = values.repository
			? normalizeRepositoryIdentity(values.repository)
			: await discoverCheckoutRepository(checkoutRoot)
		if (!repository) {
			throw new Error(
				`Cannot determine repository identity for ${checkoutRoot}; pass --repository <git-url>.`,
			)
		}
		const registryPath = resolveSourceRegistryPath(values.registry)
		registerSourceCheckout({ registryPath, repository, checkoutRoot })
		ctx.log(`Registered ${repository}`)
		ctx.log(`  checkout: ${checkoutRoot}`)
		ctx.log(`  registry: ${registryPath}`)
	},
})

export const sourceDoctorCommand = define({
	...sourceDoctorDefinition,
	async run(ctx) {
		const plan = await loadPlan(ctx.values as SourceWorkspaceValues)
		const diagnostics = await diagnoseSourceWorkspacePlan(plan)
		printPlan(ctx.log, plan)
		for (const warning of diagnostics.warnings) ctx.log(`warning: ${warning}`)
		if (diagnostics.errors.length > 0) {
			throw new Error(diagnostics.errors.join('\n'))
		}
		ctx.log('Source workspace is valid.')
	},
})

export const sourceBuildCommand = define({
	...sourceBuildDefinition,
	async run(ctx) {
		const values = ctx.values as SourceBuildValues
		const plan = await loadCheckedPlan(values)
		await buildSourceWorkspace({
			plan,
			packages: normalizeSourceBuildPackages(values.package),
			force: values.force,
			log: ctx.log,
		})
	},
})

export const sourceInstallCommand = define({
	...sourceInstallDefinition,
	async run(ctx) {
		const values = ctx.values as SourceWorkspaceValues & {
			build: boolean
			'frozen-lockfile': boolean
		}
		const plan = await loadCheckedPlan(values)
		await installSourceWorkspace({
			plan,
			build: values.build,
			frozenLockfile: values['frozen-lockfile'],
			log: ctx.log,
		})
	},
})

export const sourceCommand = define({
	...sourceCommandDefinition,
	async run(ctx) {
		const plan = await loadPlan(ctx.values as SourceWorkspaceValues)
		printPlan(ctx.log, plan)
	},
})

async function loadCheckedPlan(values: SourceWorkspaceValues) {
	const plan = await loadPlan(values)
	const diagnostics = await diagnoseSourceWorkspacePlan(plan, { checkOverlay: false })
	if (diagnostics.errors.length > 0) throw new Error(diagnostics.errors.join('\n'))
	return plan
}

function loadPlan(values: SourceWorkspaceValues) {
	return createSourceWorkspacePlan({
		root: resolve(process.cwd(), values.root || '.'),
		configPath: values.config,
		registryPath: resolveSourceRegistryPath(values.registry),
	})
}

function normalizeSourceBuildPackages(value: SourceBuildValues['package']): string[] | undefined {
	if (!value) return undefined
	const packages = (Array.isArray(value) ? value : [value])
		.map((name) => name.trim())
		.filter(Boolean)
	return packages.length > 0 ? [...new Set(packages)] : undefined
}

function printPlan(log: (...args: unknown[]) => void, plan: Awaited<ReturnType<typeof loadPlan>>) {
	log(`consumer: ${plan.root}`)
	log(`config: ${describeSourcePath(plan.root, plan.configPath)}`)
	log(`registry: ${plan.registryPath}`)
	log('sources:')
	for (const checkout of plan.checkouts) {
		const selected = plan.selectedByRepository.get(checkout.repository) ?? []
		log(`  - ${checkout.repository}`)
		log(`    checkout: ${checkout.root}`)
		log(`    origin: ${checkout.origin}`)
		log(`    packages: ${selected.map((pkg) => pkg.name).join(', ') || '(none)'}`)
		log(
			`    artifacts: ${
				selected
					.filter((pkg) => sourcePackageNeedsBuild(pkg.manifest))
					.map((pkg) => pkg.name)
					.join(', ') || '(none)'
			}`,
		)
	}
}
