// newCommand.ts (ESM) — prompt 只问 packageName；位置参数决定输出基目录
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import inquirer from 'inquirer'
import nodePlop, { type NodePlopAPI } from 'node-plop'
import { dirname, join, resolve } from 'pathe'
import { resolveTemplatesDir } from './utils'

type PM = 'pnpm' | 'npm' | 'yarn'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/* ----------------- utils ----------------- */
function kebabCase(s: string) {
	return String(s)
		.trim()
		.replace(/^@[^/]+\/+/g, '') // 去掉 scope，稍后再拼回
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

function pascalCase(s: string) {
	const k = kebabCase(s)
	return k
		.split('-')
		.filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join('')
}

function parsePackageName(input: string) {
	const raw = String(input).trim()
	if (!raw) throw new Error('Missing packageName')
	const m = raw.match(/^(@[^/]+)\/(.+)$/)
	if (m) return { scope: m[1], name: kebabCase(m[2]), packageName: `${m[1]}/${kebabCase(m[2])}` }
	const name = kebabCase(raw)
	return { scope: '', name, packageName: name }
}

function isEmptyDir(dir: string) {
	return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0
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

async function run(pm: PM | 'git', args: string[], cwd: string) {
	return new Promise<void>((resolvePromise, reject) => {
		const child = spawn(pm, args, {
			stdio: 'inherit',
			cwd,
			shell: process.platform === 'win32',
		})
		child.on('exit', (code) =>
			code === 0 ? resolvePromise() : reject(new Error(`${pm} ${args.join(' ')} failed`)),
		)
	})
}

/* ----------------- command ----------------- */
export function newCommand() {
	const cmd = new Command('new').description('Scaffold from templates')

	cmd
		.command('plugin')
		.description('Generate a plugin package (prompt only for packageName)')
		.argument('[dest]', 'destination base dir (relative to --root)', 'packages') // ← 任意替代 packages
		.option('--root <path>', 'workspace root (destBasePath)', '.')
		.option('--template <nameOrPath>', 'template name or absolute path', 'plugin')
		.option('--pm <pnpm|npm|yarn>', 'package manager (auto-detect by default)')
		.option('--force', 'overwrite existing files', false)
		.option('--no-install', 'skip installing deps', false)
		.option('--no-git', 'skip git init', false)
		.option('--dry-run', 'show plan only', false)
		// 可选：如果你想跳过 prompt 可传 --name，否则必问
		.option('--name <packageName>', 'full npm name or short name, e.g. @scope/foo or foo')
		.action(async (destArg: string | undefined, opts) => {
			// 1) 只问 packageName
			const name =
				opts.name ??
				(
					await inquirer.prompt([
						{
							type: 'input',
							name: 'pkg',
							message: 'Package name (@scope/name or name)',
							validate: (v: string) => {
								const raw = String(v).trim()
								if (!raw) return 'required'
								const ok = /^(@[\w-]+\/)?[a-z0-9][a-z0-9-]*$/i.test(raw)
								return ok || 'use @scope/name or name (letters/digits/dashes)'
							},
							filter: (v: string) => String(v).trim(),
						},
					])
				).pkg

			const { name: pluginName, packageName } = parsePackageName(name)
			const className = pascalCase(pluginName)
			const year = new Date().getFullYear()

			// 2) 目录解析：位置参数 dest 决定基目录
			const workspaceRoot = resolve(process.cwd(), opts.root ?? '.')
			const baseDir = resolve(workspaceRoot, destArg ?? 'packages')
			const targetDir = resolve(baseDir, pluginName)

			if (!opts.force && !isEmptyDir(targetDir)) {
				throw new Error(`Target exists and not empty: ${targetDir}\nUse --force to overwrite.`)
			}

			// 3) 模板来源
			const templateNameOrPath = String(opts.template ?? 'plugin')
			const base =
				templateNameOrPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(templateNameOrPath)
					? templateNameOrPath
					: (resolveTemplatesDir?.(templateNameOrPath) ??
						resolve(__dirname, 'templates', templateNameOrPath))

			// 4) plop（只注入最小数据集）
			const plop: NodePlopAPI = await nodePlop(undefined, {
				destBasePath: workspaceRoot,
				force: !!opts.force,
			})
			plop.setHelper('kebabCase', kebabCase)
			plop.setHelper('pascalCase', pascalCase)
			plop.setHelper('capitalize', (s: unknown) => {
				const t = typeof s === 'string' ? s : ''
				return t ? t[0]!.toUpperCase() + t.slice(1) : ''
			})

			const data = { pluginName, packageName, className, year }

			plop.setGenerator('plugin', {
				description: 'Generate a plugin package',
				prompts: [],
				actions: [
					{
						type: 'addMany',
						destination: join(baseDir, '{{kebabCase pluginName}}'),
						base,
						templateFiles: join(base, '**/*'),
						data,
						abortOnFail: true,
						force: !!opts.force,
						verbose: true,
						globOptions: { dot: true }, // 包含 .gitignore 等
					},
				],
			})

			if (opts.dryRun) {
				console.log('\n[Dry Run] Would generate at:', targetDir)
				console.log('Data:', data)
				return
			}

			fs.mkdirSync(targetDir, { recursive: true })
			const gen = plop.getGenerator('plugin')
			console.log(`\n→ Generating plugin to ${targetDir}`)
			const res = await gen.runActions(data)
			for (const ch of res.changes) console.log('created:', ch.path)
			for (const fl of res.failures) console.error('failure:', fl.error || fl.message)

			// 5) git（可关）
			if (opts.git !== false) {
				try {
					await run('git', ['init'], targetDir as any)
					await run('git', ['add', '.'], targetDir as any)
				} catch {}
			}

			// 6) 安装（自动探测或手动指定）
			if (opts.install === false) {
				console.log('\n(skipped install)')
				console.log(`\n✔ Done.\ncd ${targetDir}\n`)
				return
			}
			const pm: PM = opts.pm ?? detectPm(workspaceRoot, 'pnpm')
			console.log(`\n→ Installing deps with ${pm}...`)
			const pmArgs: string[] = pm === 'yarn' ? [] : ['i']
			await run(pm, pmArgs, targetDir)

			console.log(`\n✔ Done.\ncd ${targetDir}\n${pm} dev\n`)
		})

	return cmd
}
