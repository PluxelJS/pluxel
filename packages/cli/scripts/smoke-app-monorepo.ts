import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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

	await verifyBundledUserDocs(repositoryRoot)

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
	await verifyFrozenApplicationDistribution(applicationRoot)

	await generateFromTemplate(
		{
			templateBase: resolve(import.meta.dirname, '../templates/plugin'),
			targetDir: pluginRoot,
			data: {
				pluginName: 'smoke',
				packageName: 'pluxel-plugin-smoke',
				className: 'Smoke',
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
	await verifyStandalonePluginPack(pluginRoot)
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

async function verifyBundledUserDocs(root: string): Promise<void> {
	const sourceRoot = resolve(root, 'user-docs')
	const bundledRoot = resolve(root, 'packages/cli/dist/user-docs')
	const [sourceEntries, bundledEntries] = await Promise.all([
		readdir(sourceRoot),
		readdir(bundledRoot),
	])
	const sourceFiles = sourceEntries.sort()
	const bundledFiles = bundledEntries.sort()
	if (JSON.stringify(bundledFiles) !== JSON.stringify(sourceFiles)) {
		throw new Error('CLI bundled user-docs file list differs from source')
	}
	for (const file of sourceFiles) {
		const [source, bundled] = await Promise.all([
			readFile(resolve(sourceRoot, file), 'utf8'),
			readFile(resolve(bundledRoot, file), 'utf8'),
		])
		if (bundled !== source) throw new Error(`CLI bundled user doc differs from source: ${file}`)
	}
}

async function verifyStandalonePluginPack(root: string): Promise<void> {
	const output = await runPnpmCapture(['pack', '--dry-run', '--json'], root)
	const manifest = JSON.parse(output) as { files?: Array<{ path?: string }> }
	const files = (manifest.files ?? []).map((file) => file.path).filter(Boolean) as string[]
	for (const required of ['dist/index.mjs', 'dist/index.d.mts', 'package.json', 'README.md']) {
		if (!files.includes(required)) throw new Error(`Standalone plugin pack is missing ${required}`)
	}
	const unexpected = files.filter(
		(file) => file.endsWith('.map') || file.startsWith('src/') || file.startsWith('tests/'),
	)
	if (unexpected.length > 0) {
		throw new Error(`Standalone plugin pack contains development files: ${unexpected.join(', ')}`)
	}
}

async function runPnpm(
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<void> {
	const command = process.env.npm_execpath ?? 'pnpm'
	await runProcess(command, args, cwd, environment)
}

async function runPnpmCapture(args: string[], cwd: string): Promise<string> {
	const command = process.env.npm_execpath ?? 'pnpm'
	return new Promise<string>((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
		})
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8')
		child.stderr.setEncoding('utf8')
		child.stdout.on('data', (chunk: string) => (stdout += chunk))
		child.stderr.on('data', (chunk: string) => (stderr += chunk))
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) resolvePromise(stdout)
			else {
				reject(
					new Error(
						`pnpm ${args.join(' ')} failed (${signal ?? code ?? 'unknown'}): ${stderr || stdout}`,
					),
				)
			}
		})
	})
}

async function runProcess(
	command: string,
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<void> {
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

async function verifyFrozenApplicationDistribution(root: string): Promise<void> {
	const dist = resolve(root, 'web/dist')
	const deployment = JSON.parse(
		await readFile(resolve(dist, 'pluxel-deployment.json'), 'utf8'),
	) as {
		kind?: string
		capabilities?: { workbench?: { included?: boolean } }
	}
	if (
		deployment.kind !== 'pluxel-static-application' ||
		deployment.capabilities?.workbench?.included !== true
	) {
		throw new Error('Generated application deployment manifest is incomplete')
	}
	await Promise.all([
		readFile(resolve(dist, 'workbench/public/.vite/manifest.json')),
		readFile(resolve(dist, 'public/index.html')),
	])

	const entry = pathToFileURL(resolve(dist, 'app.mjs')).href
	const smoke = [
		'const app = await import(process.argv[1])',
		'try {',
		"\tif (app.ctx.workbench.enabled) throw new Error('Workbench should be disabled by startup config')",
		'\tconst origin = `http://${app.address.host}:${app.address.port}`',
		'\tconst health = await fetch(`${origin}/__pluxel/plugins/StarterAppPlugin/api/health`)',
		'\tif (!health.ok || (await health.json()).ok !== true) throw new Error(`Frozen health route returned ${health.status}`)',
		"\tconst page = await fetch(`${origin}/nested/page`, { headers: { accept: 'text/html' } })",
		'\tif (!page.ok || !(await page.text()).includes(\'<div id="root"></div>\')) throw new Error(`Frozen SPA fallback returned ${page.status}`)',
		'} finally {',
		'\tawait app.stop()',
		'}',
	].join('\n')
	await runProcess(process.execPath, ['--input-type=module', '--eval', smoke, entry], root, {
		PLUXEL_HOST_PORT: '0',
		PLUXEL_WORKBENCH: 'false',
	})
}
