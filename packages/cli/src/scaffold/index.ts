import { cancel, intro, isCancel, note, outro, spinner, text } from '@clack/prompts'
import { type ArgValues, define } from 'gunshi'
import { basename, resolve } from 'pathe'
import { newCommandArgs, newCommandDefinition } from '../command-manifest'
import { detectPm, formatPackageScriptCommand, type PM, runPackageManager } from '../utils/pm'
import {
	parsePackageIdentity,
	parsePackageName,
	pascalCase,
	suggestPackageName,
	validatePackageName,
} from './name'
import {
	ensureTemplate,
	generateFromTemplate,
	promptTemplateData,
	resolveTemplateBase,
} from './template'
import {
	formatWorkspaceRoot,
	resolveDestination,
	resolveWorkspaceRoot,
	type WorkspaceReason,
} from './workspace'
import { resolveTemplatesDir } from './utils'

export { parsePackageIdentity, parsePackageName } from './name'

type NewCommandArgs = typeof newCommandArgs
type NewCommandValues = ArgValues<NewCommandArgs>

type ScaffoldPlan = {
	pluginName: string
	packageName: string
	className: string
	workspaceRoot: string
	targetDir: string
	templateBase: string
	workspaceReason: WorkspaceReason
	force: boolean
	dryRun: boolean
	install: boolean
	pm?: PM
	year: number
}

export const newCommand = define({
	...newCommandDefinition,
	async run(ctx) {
		const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY)

		const packageInput = await ensurePackageName(ctx.values.name)
		if (!packageInput) return

		const templateInput = await ensureTemplate(ctx.values.template)
		if (!templateInput) return

		const plan = createScaffoldPlan(packageInput, templateInput, ctx.values)
		intro(`Create ${plan.packageName}`)

		const rootLabel = formatWorkspaceRoot(plan.workspaceRoot, plan.workspaceReason)
		const summary = [
			`Root: ${rootLabel}`,
			`Target: ${plan.targetDir}`,
			`Template: ${plan.templateBase}`,
			`Install: ${plan.install ? (plan.pm ?? 'auto') : 'skipped'}`,
			plan.force ? 'Overwrite: enabled' : '',
		]
			.filter(Boolean)
			.join('\n')
		note(summary, plan.dryRun ? 'Dry run' : 'Plan')

		const data = await buildTemplateData(plan)
		if (!data) return

		const generateSpinner = interactive && !plan.dryRun ? spinner({ indicator: 'dots' }) : null
		if (generateSpinner) generateSpinner.start('Generating files...')
		let generated: boolean
		try {
			generated = await generateFromTemplate(
				{
					templateBase: plan.templateBase,
					targetDir: plan.targetDir,
					data,
					force: plan.force,
					dryRun: plan.dryRun,
				},
				plan.dryRun || !interactive ? ctx.log : () => {},
			)
			if (generateSpinner) generateSpinner.stop('Generated.')
		} catch (error) {
			if (generateSpinner) generateSpinner.stop('Failed.', 1)
			throw error
		}

		if (plan.dryRun) {
			outro('No changes made.')
			return
		}
		if (!generated) return

		if (plan.install) {
			const pm = plan.pm ?? (await detectPm(plan.workspaceRoot))
			const installSpinner = interactive ? spinner({ indicator: 'timer' }) : null
			if (installSpinner) installSpinner.start(`Installing deps with ${pm}...`)
			else ctx.log(`\n→ Installing deps with ${pm}...`)

			try {
				await runPackageManager(pm, ['install'], plan.targetDir)
				if (installSpinner) installSpinner.stop('Installed.')
			} catch (error) {
				if (installSpinner) installSpinner.stop('Failed.', 1)
				throw error
			}

			ctx.log(`\nNext: ${formatPackageScriptCommand(pm, 'verify')}`)
		}

		outro(`✔ Done.\ncd ${plan.targetDir}`)
	},
})

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

function createScaffoldPlan(
	input: string,
	template: string,
	values: NewCommandValues,
): ScaffoldPlan {
	const { dest: destValues, root, force = false, install = true, pm } = values
	const dryRun = values['dry-run']
	const dest = resolveScaffoldDestinationInput(destValues)
	const cwd = process.cwd()

	const rootInfo = resolveWorkspaceRoot(cwd, root)
	const templateBase = resolveTemplateBase(template)
	const createsWorkspace = basename(templateBase) === 'app-monorepo'
	const builtInPackageManager = resolveBuiltInTemplatePackageManager(templateBase)
	if (builtInPackageManager && pm && pm !== builtInPackageManager) {
		throw new Error(
			`The ${basename(templateBase)} template requires ${builtInPackageManager}; received --pm ${pm}.`,
		)
	}
	const destPlan =
		createsWorkspace && !dest ? { destBase: cwd } : resolveDestination(rootInfo, dest)

	const { name: pluginName, packageName } = resolveScaffoldIdentity(input, templateBase)
	const targetDir = resolve(destPlan.destBase, pluginName)

	const plan: ScaffoldPlan = {
		pluginName,
		packageName,
		className: pascalCase(pluginName),
		workspaceRoot: rootInfo.root,
		targetDir,
		templateBase,
		workspaceReason: rootInfo.reason,
		force,
		dryRun,
		install,
		year: new Date().getFullYear(),
	}

	const planPackageManager = builtInPackageManager ?? pm
	if (planPackageManager) plan.pm = planPackageManager
	return plan
}

export function resolveScaffoldDestinationInput(
	input: readonly string[] | string | undefined,
): string | undefined {
	const values = typeof input === 'string' ? [input] : input
	if (!values || values.length === 0) return undefined
	if (values.length > 1) throw new Error('Expected at most one scaffold destination')
	return values[0]
}

export function resolveBuiltInTemplatePackageManager(
	templateBase: string,
	templatesDir = resolveTemplatesDir(),
): PM | undefined {
	const resolvedBase = resolve(templateBase)
	return ['app-monorepo', 'plugin'].some((name) => resolvedBase === resolve(templatesDir, name))
		? 'pnpm'
		: undefined
}

export function resolveScaffoldIdentity(input: string, templateBase: string) {
	return basename(templateBase) === 'app-monorepo'
		? parsePackageIdentity(input)
		: parsePackageName(input)
}

async function buildTemplateData(plan: ScaffoldPlan): Promise<Record<string, string> | null> {
	const baseData: Record<string, string> = {
		pluginName: plan.pluginName,
		packageName: plan.packageName,
		className: plan.className,
		year: String(plan.year),
	}

	const prompted = await promptTemplateData(plan.templateBase, baseData)
	if (!prompted) return null
	return { ...baseData, ...prompted }
}
