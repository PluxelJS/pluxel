import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { Command } from 'commander'
import inquirer from 'inquirer'
import nodePlop, { type NodePlopAPI } from 'node-plop'
import { join, resolve } from 'pathe'
import { kebabCase, resolveTemplatesDir } from './utils'

async function run(pm: 'pnpm' | 'npm' | 'yarn', args: string[], cwd: string) {
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

export function newCommand() {
	const cmd = new Command('new').description('Scaffold from templates')

	// 子命令：plugin → 生成到 plugins/<name>
	cmd
		.command('plugin')
		.description('Generate a plugin into plugins/<name>')
		.option('-n, --name <string>', 'package name (required if no prompt)')
		.option('--pm <pnpm|npm|yarn>', 'package manager', 'pnpm')
		.option('--desc <string>', 'description', 'A TypeScript plugin')
		.option('--author <string>', 'author', 'you')
		.option('--cwd <path>', 'workspace root where "plugins" lives', '.')
		.option('--force', 'overwrite existing files', false)
		.option('--yes', 'skip all prompts, use flags/defaults', false)
		.option('--no-install', 'do not run package manager install', false)
		.action(async (opts) => {
			// 收集参数（可交互）
			let answers = {
				name: opts.name as string | undefined,
				pm: (opts.pm as 'pnpm' | 'npm' | 'yarn') ?? 'pnpm',
				desc: opts.desc as string,
				author: opts.author as string,
			}

			if (!opts.yes) {
				answers = Object.assign(
					answers,
					await inquirer.prompt([
						{
							type: 'input',
							name: 'name',
							message: 'Plugin package name?',
							when: !opts.name,
							validate: (v: string) => !!v || 'required',
						},
						{
							type: 'list',
							name: 'pm',
							message: 'Package manager',
							choices: ['pnpm', 'npm', 'yarn'],
							when: !opts.pm,
							default: 'pnpm',
						},
						{
							type: 'input',
							name: 'desc',
							message: 'Description',
							when: !opts.desc,
							default: 'A TypeScript plugin',
						},
						{
							type: 'input',
							name: 'author',
							message: 'Author',
							when: !opts.author,
							default: 'you',
						},
					]),
				)
			}

			const pkgName = kebabCase(String(answers.name || ''))
			if (!pkgName) throw new Error('Missing --name')

			const workspaceRoot = resolve(process.cwd(), opts.cwd ?? '.')
			const targetDir = resolve(workspaceRoot, 'plugins', pkgName)

			// 幂等：默认不覆盖
			if (!opts.force && fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
				throw new Error(`Target exists and not empty: ${targetDir}\nUse --force to overwrite.`)
			}
			fs.mkdirSync(targetDir, { recursive: true })

			// 准备 Plop (Node API)
			const plop: NodePlopAPI = await nodePlop(undefined, {
				destBasePath: workspaceRoot,
				force: false,
			})
			plop.setHelper('kebabCase', kebabCase)

			// 注册 "plugin" 模板：来源 plop-templates/plugin/*
			const base = resolveTemplatesDir('plugin')
			plop.setGenerator('plugin', {
				description: 'Generate a plugin package',
				prompts: [], // 已由 commander + inquirer 收集
				actions: [
					{
						type: 'addMany',
						destination: join('src', 'plugins', '{{kebabCase name}}'),
						base,
						templateFiles: join(base, '**/*'),
						data: { ...answers, name: pkgName },
						force: !!opts.force,
						abortOnFail: true,
					},
				],
			})

			const gen = plop.getGenerator('plugin')
			console.log(`\n→ Generating plugin to ${targetDir}`)
			const res = await gen.runActions({ ...answers, name: pkgName })

			for (const ch of res.changes) console.log('created:', ch.path)
			for (const fl of res.failures) console.error('failure:', fl.error || fl.message)

			if (opts.install === false) {
				console.log('\n(skipped install)')
				return
			}

			console.log('\n→ Installing deps...')
			await run(answers.pm as any, answers.pm === 'yarn' ? [] : ['i'], targetDir)

			console.log(`\n✔ Done.\ncd ${targetDir}\n${answers.pm} dev\n`)
		})

	return cmd
}
