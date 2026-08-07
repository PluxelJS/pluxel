import { existsSync } from 'node:fs'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import {
	sourceBuildDefinition,
	sourceCommandDefinition,
	sourceDoctorDefinition,
	sourceInstallDefinition,
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
import { registerSourceCheckout } from '../source/registry'
import { sourcePackageNeedsBuild } from '../source/workspace'

type SourceWorkspaceValues = ArgValues<typeof sourceWorkspaceArgs>
type SourceRegisterValues = ArgValues<typeof sourceRegisterArgs>

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
		const plan = await loadCheckedPlan(ctx.values as SourceWorkspaceValues)
		await buildSourceWorkspace({ plan, log: ctx.log })
	},
})

export const sourceInstallCommand = define({
	...sourceInstallDefinition,
	async run(ctx) {
		const values = ctx.values as SourceWorkspaceValues & { build: boolean }
		const plan = await loadCheckedPlan(values)
		await installSourceWorkspace({ plan, build: values.build, log: ctx.log })
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
	const diagnostics = await diagnoseSourceWorkspacePlan(plan)
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

function printPlan(log: (...args: unknown[]) => void, plan: Awaited<ReturnType<typeof loadPlan>>) {
	log(`consumer: ${plan.root}`)
	log(`config: ${describeSourcePath(plan.root, plan.configPath)}`)
	log(`registry: ${plan.registryPath}`)
	log('sources:')
	for (const checkout of plan.checkouts) {
		const selected = plan.selectedByRepository.get(checkout.repository) ?? []
		log(`  - ${checkout.repository}`)
		log(`    checkout: ${checkout.root}`)
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
