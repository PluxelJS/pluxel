import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { parse, stringify } from 'yaml'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pluxel-app-template-'))
const tarballRoot = resolve(temporaryRoot, 'tarballs')
const cliInstallRoot = resolve(temporaryRoot, 'cli-install')
const applicationScaffoldRoot = resolve(temporaryRoot, 'applications')
const pluginScaffoldRoot = resolve(temporaryRoot, 'plugins')
const applicationRoot = resolve(applicationScaffoldRoot, 'starter-app')
const pluginRoot = resolve(pluginScaffoldRoot, 'smoke')
const publishRoots = [
	'@pluxel/core',
	'@pluxel/rolldown',
	'@pluxel/runtime',
	'@pluxel/runtime-static',
	'@pluxel/test',
	'@pluxel/cli',
] as const

try {
	await mkdir(tarballRoot, { recursive: true })
	const publishPackages = await resolveLocalPublishClosure(repositoryRoot, publishRoots)
	await runPnpm(
		['exec', 'turbo', 'run', 'build', ...publishPackages.map(({ name }) => `--filter=${name}`)],
		repositoryRoot,
	)

	await verifyBundledUserDocs(repositoryRoot)

	const overrides: Record<string, string> = {}
	for (const item of publishPackages) {
		const tarball = resolve(tarballRoot, `${item.name.replaceAll(/[@/]/g, '-')}.tgz`)
		await runPnpmCapture(['--dir', resolve(repositoryRoot, item.path), 'pack', '--out', tarball])
		overrides[item.name] = `file:${tarball}`
	}

	const cliTarball = overrides['@pluxel/cli']
	if (!cliTarball) throw new Error('Local publish closure did not include @pluxel/cli')
	await installPackedCli(cliInstallRoot, cliTarball)
	await mkdir(applicationScaffoldRoot, { recursive: true })
	await runPackedCli(cliInstallRoot, applicationScaffoldRoot, [
		'new',
		'--template',
		'app-monorepo',
		'--name',
		'@smoke/dry-run',
		'--dry-run',
		'--no-install',
	])
	const dryRunEntries = await readdir(applicationScaffoldRoot)
	if (dryRunEntries.includes('dry-run')) {
		throw new Error('Scaffold dry run wrote a target directory')
	}
	await runPackedCli(cliInstallRoot, applicationScaffoldRoot, [
		'new',
		'--template',
		'app-monorepo',
		'--name',
		'@smoke/starter-app',
		'--no-install',
	])
	await assertGeneratedGitIgnore(applicationRoot)

	const workspacePath = resolve(applicationRoot, 'pnpm-workspace.yaml')
	const workspace = parse(await readFile(workspacePath, 'utf8')) as Record<string, unknown>
	workspace.overrides = overrides
	await writeFile(workspacePath, stringify(workspace, { singleQuote: true }))

	await runPnpm(['install', '--frozen-lockfile=false'], applicationRoot)
	await runPnpm(['verify'], applicationRoot, { CI: '1' })
	await verifyFrozenApplicationDistribution(applicationRoot)

	await mkdir(pluginScaffoldRoot, { recursive: true })
	await runPackedCli(cliInstallRoot, pluginScaffoldRoot, [
		'new',
		'--template',
		'plugin',
		'--name',
		'pluxel-plugin-smoke',
		'--no-install',
	])
	await assertGeneratedGitIgnore(pluginRoot)

	const pluginWorkspacePath = resolve(pluginRoot, 'pnpm-workspace.yaml')
	const pluginWorkspace = parse(await readFile(pluginWorkspacePath, 'utf8')) as Record<
		string,
		unknown
	>
	pluginWorkspace.overrides = overrides
	await writeFile(pluginWorkspacePath, stringify(pluginWorkspace, { singleQuote: true }))

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

type LocalPublishPackage = {
	name: string
	path: string
	manifest: {
		dependencies?: Record<string, string>
		optionalDependencies?: Record<string, string>
		peerDependencies?: Record<string, string>
		peerDependenciesMeta?: Record<string, { optional?: boolean }>
	}
}

async function resolveLocalPublishClosure(
	root: string,
	rootNames: readonly string[],
): Promise<LocalPublishPackage[]> {
	const packagesRoot = resolve(root, 'packages')
	const entries = await readdir(packagesRoot, { withFileTypes: true })
	const discovered = new Map<string, LocalPublishPackage>()
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const path = `packages/${entry.name}`
		const manifestPath = resolve(root, path, 'package.json')
		let manifest: LocalPublishPackage['manifest'] & {
			name?: string
			private?: boolean
		}
		try {
			manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifest
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
			throw error
		}
		if (manifest.private === true || !manifest.name) continue
		discovered.set(manifest.name, { name: manifest.name, path, manifest })
	}

	const closure = new Map<string, LocalPublishPackage>()
	const pending = [...rootNames]
	while (pending.length > 0) {
		const name = pending.shift()!
		if (closure.has(name)) continue
		const item = discovered.get(name)
		if (!item) throw new Error(`Local publish package not found: ${name}`)
		closure.set(name, item)
		const dependencies = {
			...item.manifest.dependencies,
			...item.manifest.optionalDependencies,
		}
		for (const dependency of Object.keys(dependencies)) {
			if (discovered.has(dependency)) pending.push(dependency)
		}
		for (const dependency of Object.keys(item.manifest.peerDependencies ?? {})) {
			if (
				discovered.has(dependency) &&
				item.manifest.peerDependenciesMeta?.[dependency]?.optional !== true
			) {
				pending.push(dependency)
			}
		}
	}
	return [...closure.values()].sort((left, right) => left.name.localeCompare(right.name))
}

async function installPackedCli(root: string, cliTarball: string): Promise<void> {
	await mkdir(root, { recursive: true })
	await writeFile(
		resolve(root, 'package.json'),
		`${JSON.stringify(
			{
				name: 'pluxel-cli-smoke-install',
				private: true,
				dependencies: { '@pluxel/cli': cliTarball },
			},
			null,
			2,
		)}\n`,
	)
	await runPnpm(['install', '--frozen-lockfile=false'], root)
}

async function runPackedCli(root: string, cwd: string, args: string[]): Promise<void> {
	const cli = resolve(root, 'node_modules/@pluxel/cli/bin/pluxel.mjs')
	await runProcess(process.execPath, [cli, ...args], cwd)
}

async function assertGeneratedGitIgnore(root: string): Promise<void> {
	const contents = await readFile(resolve(root, '.gitignore'), 'utf8')
	if (!contents.includes('node_modules/') || !contents.includes('.pluxel/')) {
		throw new Error(`Generated .gitignore is incomplete: ${root}`)
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
			else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code ?? 'unknown'})`))
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
		'\tconst health = await fetch(`${origin}/api/health`)',
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
