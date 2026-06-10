import { cancel, intro, isCancel, note, outro, spinner, text } from '@clack/prompts'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import { resolvePluginEnv } from '@pluxel/build/cli'
import { detectPm, type PM, runPackageManager } from '../utils/pm'
import { parsePackageName, pascalCase, suggestPackageName, validatePackageName } from './name'
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

export { parsePackageName } from './name'

const newCommandArgs = {
	dest: {
		type: 'positional',
		description: 'Destination base dir (relative to --root; auto when omitted)',
	},
	root: {
		type: 'string',
		description: 'Workspace root (auto-detect by default)',
	},
	template: {
		type: 'string',
		description: 'Template name or path (auto/prompt by default)',
	},
	pm: {
		type: 'enum',
		description: 'Package manager (auto-detect by default)',
		choices: ['pnpm', 'npm', 'yarn'],
	},
	force: {
		type: 'boolean',
		description: 'Overwrite existing files',
		default: false,
	},
	install: {
		type: 'boolean',
		description: 'Install dependencies after generation',
		default: true,
		negatable: true,
	},
	dryRun: {
		type: 'boolean',
		description: 'Show the plan without touching the filesystem',
		default: false,
	},
	name: {
		type: 'string',
		description: 'Full npm name or short name, e.g. @scope/foo or foo',
	},
} as const

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
	name: 'new',
	description: 'Scaffold from templates',
	args: newCommandArgs,
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

			ctx.log(`\n${pm} build`)
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
		placeholder: suggestion ?? '@scope/plugin-example',
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
	const { dest, root, force = false, dryRun = false, install = true, pm } = values
	const cwd = process.cwd()

	const rootInfo = resolveWorkspaceRoot(cwd, root)
	const destPlan = resolveDestination(rootInfo, dest)

	const envConfig = resolvePluginEnv()
	const { name: pluginName, packageName } = parsePackageName(input, envConfig.pluginPrefixes)
	const targetDir = resolve(destPlan.destBase, pluginName)

	const plan: ScaffoldPlan = {
		pluginName,
		packageName,
		className: pascalCase(pluginName),
		workspaceRoot: rootInfo.root,
		targetDir,
		templateBase: resolveTemplateBase(template),
		workspaceReason: rootInfo.reason,
		force,
		dryRun,
		install,
		year: new Date().getFullYear(),
	}

	if (pm) plan.pm = pm
	return plan
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
