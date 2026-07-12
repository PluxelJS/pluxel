import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { parse, stringify } from 'yaml'
import { generateFromTemplate } from '../src/scaffold/template.ts'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const templateBase = resolve(import.meta.dirname, '../templates/app-monorepo')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pluxel-app-template-'))
const tarballRoot = resolve(temporaryRoot, 'tarballs')
const applicationRoot = resolve(temporaryRoot, 'starter-app')
const pluginRoot = resolve(temporaryRoot, 'standalone-plugin')

const packages = [
	{ name: '@pluxel/core', path: 'packages/core', build: ['build'] },
	{ name: '@pluxel/rolldown', path: 'packages/rolldown', build: ['build'] },
	{ name: '@pluxel/runtime', path: 'packages/runtime', build: ['build:lib'] },
	{ name: '@pluxel/runtime-dev', path: 'packages/runtime-dev', build: ['build'] },
	{ name: '@pluxel/runtime-static', path: 'packages/runtime-static', build: ['build'] },
	{ name: '@pluxel/test', path: 'packages/test', build: ['build'] },
	{ name: '@pluxel/cli', path: 'packages/cli', build: ['build'] },
] as const

try {
	await mkdir(tarballRoot, { recursive: true })
	for (const item of packages) await runPnpm(['--filter', item.name, ...item.build], repositoryRoot)

	const overrides: Record<string, string> = {}
	for (const item of packages.filter((candidate) => candidate.name !== '@pluxel/runtime-dev')) {
		const tarball = resolve(tarballRoot, `${item.name.replaceAll(/[@/]/g, '-')}.tgz`)
		await runPnpm(['--dir', resolve(repositoryRoot, item.path), 'pack', '--out', tarball])
		overrides[item.name] = `file:${tarball}`
	}

	await generateFromTemplate(
		{
			templateBase,
			targetDir: applicationRoot,
			data: {
				pluginName: 'starter-app',
				packageName: '@smoke/starter-app',
				className: 'StarterApp',
				year: String(new Date().getFullYear()),
				description: 'Pluxel application template smoke test',
			},
			force: false,
			dryRun: false,
		},
		() => {},
	)

	const workspacePath = resolve(applicationRoot, 'pnpm-workspace.yaml')
	const workspace = parse(await readFile(workspacePath, 'utf8')) as Record<string, unknown>
	workspace.overrides = overrides
	await writeFile(workspacePath, stringify(workspace, { singleQuote: true }))

	await runPnpm(['install', '--frozen-lockfile=false'], applicationRoot)
	await runPnpm(['verify'], applicationRoot, { CI: '1' })

	await generateFromTemplate(
		{
			templateBase: resolve(import.meta.dirname, '../templates/plugin'),
			targetDir: pluginRoot,
			data: {
				pluginName: 'smoke-plugin',
				packageName: 'pluxel-plugin-smoke',
				className: 'SmokePlugin',
				year: String(new Date().getFullYear()),
				description: 'Pluxel standalone plugin template smoke test',
			},
			force: false,
			dryRun: false,
		},
		() => {},
	)

	await writeFile(
		resolve(pluginRoot, 'pnpm-workspace.yaml'),
		stringify({ packages: ['.'], overrides }),
	)

	await runPnpm(['install', '--frozen-lockfile=false'], pluginRoot)
	// This workspace file belongs to the smoke harness rather than the published template. Keep it
	// under the same formatting contract before asking the generated plugin to verify itself.
	await runPnpm(
		['exec', 'oxfmt', '-c', '.oxfmtrc.json', '--write', 'pnpm-workspace.yaml'],
		pluginRoot,
	)
	await runPnpm(['verify'], pluginRoot, { CI: '1' })
	const pluginPackRoot = resolve(pluginRoot, '.pack')
	await mkdir(pluginPackRoot, { recursive: true })
	await runPnpm(['pack', '--pack-destination', pluginPackRoot], pluginRoot)
} finally {
	if (process.env.PLUXEL_KEEP_TEMPLATE_SMOKE) {
		console.info(`Template smoke workspace kept at ${temporaryRoot}`)
	} else {
		await rm(temporaryRoot, { recursive: true, force: true })
	}
}

async function runPnpm(
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<void> {
	const command = process.env.npm_execpath ?? 'pnpm'
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			env: { ...process.env, ...environment },
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`pnpm ${args.join(' ')} failed (${signal ?? code ?? 'unknown'})`))
		})
	})
}
