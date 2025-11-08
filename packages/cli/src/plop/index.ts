import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cancel, intro, isCancel, note, outro, text } from '@clack/prompts'
import { define, type ArgValues } from 'gunshi'
import nodePlop, { type NodePlopAPI } from 'node-plop'
import { dirname, isAbsolute, join, resolve } from 'pathe'
import { resolveTemplatesDir } from './utils'

type PM = 'pnpm' | 'npm' | 'yarn'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const newCommandArgs = {
	dest: {
		type: 'positional',
		description: 'Destination base dir (relative to --root)',
		default: 'packages',
	},
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
	template: {
		type: 'string',
		description: 'Template name or absolute path',
		default: 'plugin',
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

interface ScaffoldPlan {
	pluginName: string
	packageName: string
	className: string
	workspaceRoot: string
	destBase: string
	targetDir: string
	templateBase: string
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
		const packageInput = await ensurePackageName(ctx.values.name)
		if (!packageInput) return

		const plan = createScaffoldPlan(packageInput, ctx.values)
		intro(`Create ${plan.packageName}`)

	const summary = [
		`Target: ${plan.targetDir}`,
		`Template: ${plan.templateBase}`,
		`Install: ${plan.install ? plan.pm ?? 'auto' : 'skipped'}`,
		plan.force ? 'Overwrite: enabled' : '',
	]
		.filter(Boolean)
			.join('\n')
		note(summary, plan.dryRun ? 'Dry run' : 'Plan')

		if (plan.dryRun) {
			outro('No changes made.')
			return
		}

		await generateFromTemplate(plan, ctx.log)

		if (plan.install) {
			const pm = plan.pm ?? detectPm(plan.workspaceRoot, 'pnpm')
			const args = pm === 'yarn' ? [] : ['i']
			ctx.log(`\n→ Installing deps with ${pm}...`)
			await run(pm, args, plan.targetDir)
			ctx.log(`\n${pm} dev`)
		}

		outro(`✔ Done.\ncd ${plan.targetDir}`)
	},
})

async function ensurePackageName(explicit?: string) {
	if (explicit) {
		const normalized = explicit.trim()
		const error = validatePackageName(normalized)
		if (error) {
			throw new Error(error)
		}
		return normalized
	}
	const answer = await text({
		message: 'Package name (@scope/name or name)',
		placeholder: '@scope/plugin-example',
		validate: validatePackageName,
	})
	if (isCancel(answer)) {
		cancel('Scaffold cancelled.')
		return undefined
	}
	return answer.trim()
}

function createScaffoldPlan(input: string, values: NewCommandValues): ScaffoldPlan {
	const {
		dest = 'packages',
		root = '.',
		template = 'plugin',
		force = false,
		dryRun = false,
		install = true,
		pm,
	} = values
	const workspaceRoot = resolve(process.cwd(), root)
	const destBase = resolve(workspaceRoot, dest)
	const { name: pluginName, packageName } = parsePackageName(input)
	const targetDir = resolve(destBase, pluginName)

	if (!force && !isEmptyDir(targetDir)) {
		throw new Error(`Target exists and not empty: ${targetDir}\nUse --force to overwrite.`)
	}

	return {
		pluginName,
		packageName,
		className: pascalCase(pluginName),
		workspaceRoot,
		destBase,
		targetDir,
		templateBase: resolveTemplateBase(template),
		force,
		dryRun,
		install,
		pm,
		year: new Date().getFullYear(),
	}
}

async function generateFromTemplate(plan: ScaffoldPlan, log: (...args: unknown[]) => void) {
	const plop: NodePlopAPI = await nodePlop(undefined, {
		destBasePath: plan.workspaceRoot,
		force: plan.force,
	})
	plop.setHelper('kebabCase', kebabCase)
	plop.setHelper('pascalCase', pascalCase)
	plop.setHelper('capitalize', (s: unknown) => {
		const t = typeof s === 'string' ? s : ''
		return t ? t[0]!.toUpperCase() + t.slice(1) : ''
	})

	const data = {
		pluginName: plan.pluginName,
		packageName: plan.packageName,
		className: plan.className,
		year: plan.year,
	}

	plop.setGenerator('plugin', {
		description: 'Generate a plugin package',
		prompts: [],
		actions: [
			{
				type: 'addMany',
				destination: join(plan.destBase, '{{kebabCase pluginName}}'),
				base: plan.templateBase,
				templateFiles: join(plan.templateBase, '**/*'),
				data,
				abortOnFail: true,
				force: plan.force,
				verbose: true,
				globOptions: { dot: true },
			},
		],
	})

	if (plan.dryRun) return

	fs.mkdirSync(plan.targetDir, { recursive: true })
	const generator = plop.getGenerator('plugin')
	log(`\n→ Generating plugin to ${plan.targetDir}`)
	const res = await generator.runActions(data)
	for (const change of res.changes) log('created:', change.path)
	for (const failure of res.failures) log('failure:', failure.error ?? failure.message)
}

function validatePackageName(value: string) {
	const raw = String(value).trim()
	if (!raw) return 'required'
	const ok = /^(@[\w-]+\/)?[a-z0-9][a-z0-9-]*$/i.test(raw)
	return ok ? undefined : 'use @scope/name or name (letters/digits/dashes)'
}

function kebabCase(s: string) {
	return String(s)
		.trim()
		.replace(/^@[^/]+\/+/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function pascalCase(s: string) {
	return kebabCase(s)
		.split('-')
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join('')
}

function parsePackageName(input: string) {
	const raw = String(input).trim()
	if (!raw) throw new Error('Missing packageName')
	const match = raw.match(/^(@[^/]+)\/(.+)$/)
	if (match) {
		const scope = match[1]
		const scopedName = kebabCase(match[2])
		return { scope, name: scopedName, packageName: `${scope}/${scopedName}` }
	}
	const name = kebabCase(raw)
	return { scope: '', name, packageName: name }
}

function isEmptyDir(dir: string) {
	return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0
}

function resolveTemplateBase(input: string) {
	if (isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
		return input
	}
	return resolveTemplatesDir?.(input) ?? resolve(__dirname, 'templates', input)
}

function detectPm(root: string, fallback: PM = 'pnpm'): PM {
	try {
		if (fs.existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
		if (fs.existsSync(join(root, 'yarn.lock'))) return 'yarn'
		if (fs.existsSync(join(root, 'package-lock.json'))) return 'npm'
	} catch {}
	const ua = process.env.npm_config_user_agent || ''
	if (ua.startsWith('pnpm')) return 'pnpm'
	if (ua.startsWith('yarn')) return 'yarn'
	if (ua.startsWith('npm')) return 'npm'
	return fallback
}

async function run(pm: PM, args: string[], cwd: string) {
	return new Promise<void>((resolvePromise, reject) => {
		const child = spawn(pm, args, {
			stdio: 'inherit',
			cwd,
			shell: process.platform === 'win32',
		})
		child.on('exit', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`${pm} ${args.join(' ')} failed`))
		})
	})
}
