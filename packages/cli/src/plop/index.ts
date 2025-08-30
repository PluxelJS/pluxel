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

	// Default command: Generate a plugin into packages/<name>
	cmd
		.command('plugin')
		.description('Generate a plugin into packages/<name>')
		.option('-n, --name <string>', 'package name (required if no prompt)')
		.option('--pm <pnpm|npm|yarn>', 'package manager', 'pnpm')
		.option('--desc <string>', 'description', 'A TypeScript plugin')
		.option('--author <string>', 'author', 'you')
		.option('--cwd <path>', 'workspace root where "packages" lives', '.')
		.option('--force', 'overwrite existing files', false)
		.option('--yes', 'skip all prompts, use flags/defaults', false)
		.option('--no-install', 'do not run package manager install', false)
		.action(async (opts) => {
			let answers = {
				name: opts.name as string | undefined,
				pm: (opts.pm as 'pnpm' | 'npm' | 'yarn') ?? 'pnpm',
				desc: opts.desc as string,
				author: opts.author as string,
			}

			// If "yes" flag isn't used, ask for input
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
						// Removed extra prompts for simplicity, focus only on name and package manager
						{
							type: 'list',
							name: 'pm',
							message: 'Package manager',
							choices: ['pnpm', 'npm', 'yarn'],
							when: !opts.pm,
							default: 'pnpm',
						},
					]),
				)
			}

			const pkgName = kebabCase(String(answers.name || ''))
			if (!pkgName) throw new Error('Missing --name')

			const workspaceRoot = resolve(process.cwd(), opts.cwd ?? '.')
			const targetDir = resolve(workspaceRoot, 'packages', pkgName)

			// Check if the directory already exists and has files
			if (!opts.force && fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
				throw new Error(`Target exists and not empty: ${targetDir}\nUse --force to overwrite.`)
			}
			fs.mkdirSync(targetDir, { recursive: true })

			// Setup Plop
			const plop: NodePlopAPI = await nodePlop(undefined, {
				destBasePath: workspaceRoot,
				force: false,
			})

			// Custom helper to capitalize
			plop.setHelper('capitalize', (str) => {
				if (typeof str !== 'string' || str.trim() === '') {
					return '' // return empty string if input is undefined or empty
				}
				return str.charAt(0).toUpperCase() + str.slice(1)
			})

			plop.setHelper('kebabCase', kebabCase)

			// Register the generator for the plugin
			const base = resolveTemplatesDir('plugin')
			plop.setGenerator('plugin', {
				description: 'Generate a plugin package',
				prompts: [], // Prompts handled by commander + inquirer
				actions: [
					{
						type: 'addMany',
						destination: join('packages', '{{kebabCase name}}'), // Save directly to plugin name
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
