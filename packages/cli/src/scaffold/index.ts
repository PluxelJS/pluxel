import { cancel, intro, isCancel, note, outro, select, spinner, text } from '@clack/prompts'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import { newCommandArgs, newCommandDefinition } from '../command-manifest'
import { detectPm, formatPackageScriptCommand, type PM, runPackageManager } from '../utils/pm'
import { loadTemplateContract, type TemplateContract } from './contract'
import { scaffoldError } from './errors'
import { materializeScaffoldPlan, printScaffoldPlan } from './materialize'
import { parsePackageName, pascalCase, suggestPackageName, validatePackageName } from './name'
import { authorizePlanOverwrite, compileScaffoldPlan, type ScaffoldPlan } from './plan'
import { collectTemplateAnswers, confirmOverwrite } from './prompts'
import {
	acquireTemplate,
	formatTemplateProvenance,
	listBundledTemplates,
	parseTemplateSource,
	type AcquiredTemplate,
} from './source'
import {
	formatWorkspaceRoot,
	resolveDestination,
	resolveWorkspaceRoot,
	type WorkspaceReason,
} from './workspace'

export { parsePackageName } from './name'
export { parseTemplateSource } from './source'

type NewCommandArgs = typeof newCommandArgs
type NewCommandValues = ArgValues<NewCommandArgs>

type CommandPlan = {
	pluginName: string
	packageName: string
	className: string
	workspaceRoot: string
	workspaceReason: WorkspaceReason
	targetDir: string
	force: boolean
	dryRun: boolean
	install: boolean
	packageManager?: PM
}

export const newCommand = define({
	...newCommandDefinition,
	async run(ctx) {
		const interactive = isInteractive()
		const packageInput = await ensurePackageName(ctx.values.name)
		if (!packageInput) return
		const templateInput = await ensureTemplateInput(ctx.values.template)
		if (!templateInput) return

		const source = parseTemplateSource(templateInput)
		const acquired = await acquireTemplate(source)
		try {
			const contract = await loadTemplateContract(acquired.root)
			const commandPlan = createCommandPlan(packageInput, acquired, contract, ctx.values)
			const baseData: Record<string, string> = {
				pluginName: commandPlan.pluginName,
				packageName: commandPlan.packageName,
				className: commandPlan.className,
			}
			const answers = await collectTemplateAnswers(contract, baseData, { interactive })
			if (!answers) return

			let plan = await compileScaffoldPlan({
				templateRoot: acquired.root,
				template: acquired.provenance,
				contract,
				targetDir: commandPlan.targetDir,
				data: { ...baseData, ...answers },
				force: commandPlan.force,
				install: commandPlan.install,
				packageManager: commandPlan.packageManager,
			})

			intro(`Create ${commandPlan.packageName}`)
			note(formatCommandPlan(commandPlan, acquired, plan), commandPlan.dryRun ? 'Dry run' : 'Plan')

			if (commandPlan.dryRun) {
				printScaffoldPlan(plan, ctx.log)
				outro('No changes made.')
				return
			}

			if (plan.existing.length > 0 && plan.overwrite.length === 0) {
				if (!interactive) {
					throw scaffoldError(
						'TARGET_CONFLICT',
						`Target contains existing files:\n${plan.existing.join('\n')}\nUse --force to overwrite.`,
					)
				}
				const overwrite = await confirmOverwrite(plan.existing)
				if (!overwrite) return
				plan = authorizePlanOverwrite(plan)
			}

			const generateSpinner = interactive ? spinner({ indicator: 'dots' }) : null
			if (generateSpinner) generateSpinner.start('Generating files...')
			try {
				await materializeScaffoldPlan(plan, interactive ? () => {} : ctx.log)
				if (generateSpinner) generateSpinner.stop('Generated.')
			} catch (error) {
				if (generateSpinner) generateSpinner.stop('Failed.')
				throw error
			}

			let packageManager = plan.packageManager
			if (plan.install) {
				packageManager ??= await detectPm(plan.targetDir)
				const installSpinner = interactive ? spinner({ indicator: 'timer' }) : null
				if (installSpinner) installSpinner.start(`Installing deps with ${packageManager}...`)
				else ctx.log(`\n→ Installing deps with ${packageManager}...`)
				try {
					await runPackageManager(packageManager, ['install'], plan.targetDir)
					if (installSpinner) installSpinner.stop('Installed.')
				} catch (error) {
					if (installSpinner) installSpinner.stop('Failed.')
					throw scaffoldError(
						'INSTALL_FAILED',
						`Dependency installation failed in ${plan.targetDir}. Generated files remain in place.`,
						error,
					)
				}
				ctx.log(`\nNext: ${formatPackageScriptCommand(packageManager, 'verify')}`)
			}

			outro(`✔ Done.\ncd ${plan.targetDir}`)
		} finally {
			await acquired.dispose()
		}
	},
})

export function createCommandPlan(
	input: string,
	acquired: AcquiredTemplate,
	contract: TemplateContract,
	values: NewCommandValues,
	options: { cwd?: string } = {},
): CommandPlan {
	const cwd = options.cwd ?? process.cwd()
	const dest = resolveScaffoldDestinationInput(values.dest)
	const rootInfo = resolveWorkspaceRoot(cwd, values.root)
	const destination = resolveDestination(rootInfo, dest)
	const identity = parsePackageName(input)
	const requestedPackageManager = values.pm
	const requiredPackageManager = contract.packageManager?.name
	if (
		requiredPackageManager &&
		requestedPackageManager &&
		requestedPackageManager !== requiredPackageManager
	) {
		throw new Error(
			`The ${contract.id} template requires ${requiredPackageManager}; received --pm ${requestedPackageManager}.`,
		)
	}
	const install = values.install ?? acquired.provenance.kind === 'bundled'
	const packageManager = requiredPackageManager ?? requestedPackageManager
	return {
		pluginName: identity.name,
		packageName: identity.packageName,
		className: pascalCase(identity.name),
		workspaceRoot: rootInfo.root,
		workspaceReason: rootInfo.reason,
		targetDir: resolve(destination.destBase, identity.name),
		force: values.force ?? false,
		dryRun: values['dry-run'] ?? false,
		install,
		...(packageManager ? { packageManager } : {}),
	}
}

export function resolveScaffoldDestinationInput(
	input: readonly string[] | string | undefined,
): string | undefined {
	const values = typeof input === 'string' ? [input] : input
	if (!values || values.length === 0) return undefined
	if (values.length > 1) throw new Error('Expected at most one scaffold destination')
	return values[0]
}

async function ensurePackageName(explicit?: string) {
	if (explicit) {
		const normalized = explicit.trim()
		const error = validatePackageName(normalized)
		if (error) throw new Error(error)
		return normalized
	}

	const suggestion = suggestPackageName(process.cwd())
	const answer = await text({
		message: 'Package name (@scope/name or name)',
		placeholder: suggestion ?? '@scope/example',
		defaultValue: suggestion,
		validate: validatePackageName,
	})
	if (isCancel(answer)) {
		cancel('Scaffold cancelled.')
		return undefined
	}
	return answer.trim()
}

async function ensureTemplateInput(explicit?: string): Promise<string | undefined> {
	const normalized = typeof explicit === 'string' ? explicit.trim() : ''
	if (normalized) return normalized
	const templates = listBundledTemplates()
	if (templates.length === 0) {
		throw scaffoldError(
			'TEMPLATE_NOT_FOUND',
			'No bundled templates were found in this CLI package.',
		)
	}
	if (!isInteractive()) return templates.includes('plugin') ? 'plugin' : templates[0]
	if (templates.length === 1) return templates[0]

	const custom = '__local__'
	const picked = await select({
		message: 'Template',
		options: [
			...templates.map((template) => ({ value: template, label: template })),
			{ value: custom, label: 'Local template...', hint: 'Enter ./path or an absolute path' },
		],
		initialValue: templates.includes('plugin') ? 'plugin' : templates[0],
	})
	if (isCancel(picked)) {
		cancel('Scaffold cancelled.')
		return undefined
	}
	if (picked !== custom) return String(picked)

	const entered = await text({
		message: 'Local template path',
		placeholder: './templates/company-plugin',
		validate: (value) => (String(value).trim() ? undefined : 'required'),
	})
	if (isCancel(entered)) {
		cancel('Scaffold cancelled.')
		return undefined
	}
	return String(entered).trim()
}

function formatCommandPlan(command: CommandPlan, acquired: AcquiredTemplate, plan: ScaffoldPlan) {
	return [
		`Root: ${formatWorkspaceRoot(command.workspaceRoot, command.workspaceReason)}`,
		`Target: ${plan.targetDir}`,
		`Template: ${formatTemplateProvenance(acquired.provenance)}`,
		`Files: ${plan.outputs.length}`,
		`Install: ${plan.install ? (plan.packageManager ?? 'auto') : 'skipped'}`,
		plan.overwrite.length > 0 ? `Overwrite: ${plan.overwrite.length} file(s)` : '',
	]
		.filter(Boolean)
		.join('\n')
}

function isInteractive() {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY)
}
