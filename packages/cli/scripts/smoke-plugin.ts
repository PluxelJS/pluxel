import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { parse } from 'yaml'
import { isPublishablePackage, repositoryPackages } from '../../../scripts/repository-packages.mjs'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'pluxel-cli-plugin-smoke-'))
const tarballRoot = resolve(temporaryRoot, 'tarballs')
const installRoot = resolve(temporaryRoot, 'cli-install')
const scaffoldRoot = resolve(temporaryRoot, 'scaffold')
const pluginRoot = resolve(scaffoldRoot, 'orders')
const publishRoots = ['@pluxel/cli', '@pluxel/core', '@pluxel/rolldown', '@pluxel/test'] as const

try {
	await Promise.all([
		mkdir(tarballRoot, { recursive: true }),
		mkdir(scaffoldRoot, { recursive: true }),
	])
	const publishPackages = await resolveLocalPublishClosure(repositoryRoot, publishRoots)
	for (const name of publishRoots) {
		await runVp(['run', `${name}#build`], repositoryRoot)
	}

	const overrides: Record<string, string> = {}
	for (const item of publishPackages) {
		const tarball = resolve(tarballRoot, `${item.name.replaceAll(/[@/]/g, '-')}.tgz`)
		await runVpCapture(['pm', 'pack', '--out', tarball], resolve(repositoryRoot, item.path))
		overrides[item.name] = `file:${tarball}`
	}

	const cliTarball = overrides['@pluxel/cli']
	if (!cliTarball) throw new Error('Local publish closure did not include @pluxel/cli')
	await installPackedCli(installRoot, cliTarball, overrides)
	await runProcess(
		process.execPath,
		[
			resolve(installRoot, 'node_modules/@pluxel/cli/bin/pluxel.mjs'),
			'new',
			'--template',
			'plugin',
			'--name',
			'@smoke/orders',
			'--no-install',
		],
		scaffoldRoot,
	)

	await assertGeneratedGitIgnore(pluginRoot)
	await assertGeneratedFrameworkVersions(pluginRoot)
	await appendOverrides(resolve(pluginRoot, 'pnpm-workspace.yaml'), overrides)
	await runVp(['install', '--no-frozen-lockfile'], pluginRoot)
	await runVp(['fmt', '--write', 'pnpm-workspace.yaml'], pluginRoot)
	await runVp(['exec', 'pluxel', 'workspace', 'setup'], pluginRoot)
	await runVp(['run', 'verify'], pluginRoot, { CI: '1' })
	await verifyStandalonePluginPack(pluginRoot)
} finally {
	if (process.env.PLUXEL_KEEP_TEMPLATE_SMOKE) {
		console.info(`CLI plugin smoke workspace kept at ${temporaryRoot}`)
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
	const entries = await readdir(resolve(root, 'packages'), { withFileTypes: true })
	const discovered = new Map<string, LocalPublishPackage>()
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const path = `packages/${entry.name}`
		let manifest: LocalPublishPackage['manifest'] & { name?: string; private?: boolean }
		try {
			manifest = JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8'))
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
		for (const dependency of Object.keys({
			...item.manifest.dependencies,
			...item.manifest.optionalDependencies,
		})) {
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

async function installPackedCli(
	root: string,
	tarball: string,
	overrides: Record<string, string>,
): Promise<void> {
	await mkdir(root, { recursive: true })
	await writeFile(
		resolve(root, 'package.json'),
		`${JSON.stringify({ name: 'pluxel-cli-smoke', private: true, packageManager: 'pnpm@11.28.6', dependencies: { '@pluxel/cli': tarball } }, null, 2)}\n`,
	)
	await writeFile(
		resolve(root, 'pnpm-workspace.yaml'),
		'packages:\n  - .\nallowBuilds:\n  esbuild: true\n',
	)
	await appendOverrides(resolve(root, 'pnpm-workspace.yaml'), overrides)
	await runVp(['install', '--no-frozen-lockfile'], root)
}

async function appendOverrides(path: string, overrides: Record<string, string>): Promise<void> {
	const source = await readFile(path, 'utf8')
	const lines = Object.entries(overrides)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, specifier]) => `  '${name}': '${specifier}'`)
	const marker = 'overrides:\n'
	const block = `${lines.join('\n')}\n`
	await writeFile(
		path,
		source.includes(marker)
			? source.replace(marker, `${marker}${block}`)
			: `${source.trimEnd()}\n\n${marker}${block}`,
	)
}

async function assertGeneratedGitIgnore(root: string): Promise<void> {
	const contents = await readFile(resolve(root, '.gitignore'), 'utf8')
	if (!contents.includes('node_modules/') || !contents.includes('dist/')) {
		throw new Error('Generated plugin .gitignore is incomplete')
	}
}

async function assertGeneratedFrameworkVersions(root: string): Promise<void> {
	const workspace = parse(await readFile(resolve(root, 'pnpm-workspace.yaml'), 'utf8'))
	const versions = new Map(
		repositoryPackages
			.filter(isPublishablePackage)
			.map(({ manifest }) => [manifest.name, `^${manifest.version}`]),
	)
	const ranges = Object.entries(workspace.catalog ?? {}).filter(([name]) =>
		name.startsWith('@pluxel/'),
	)
	if (ranges.length === 0) throw new Error('Generated plugin is missing its framework catalog')
	for (const [name, range] of ranges) {
		if (range !== versions.get(name))
			throw new Error(`Generated plugin ${name}: expected ${versions.get(name)}, got ${range}`)
	}
}

async function verifyStandalonePluginPack(root: string): Promise<void> {
	const output = await runVpCapture(['pm', 'pack', '--json', '--', '--dry-run'], root)
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

async function runVp(
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<void> {
	await runProcess('vp', args, cwd, {
		...environment,
		PATH: `${resolve(cwd, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
	})
}

async function runVpCapture(args: string[], cwd: string): Promise<string> {
	const command = 'vp'
	return await new Promise((accept, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: {
				...process.env,
				PATH: `${resolve(cwd, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
			},
		})
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
		child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) accept(stdout)
			else reject(new Error(`vp ${args.join(' ')} failed (${signal ?? code}): ${stderr || stdout}`))
		})
	})
}

async function runProcess(
	command: string,
	args: string[],
	cwd: string,
	environment: Record<string, string> = {},
): Promise<void> {
	await new Promise<void>((accept, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			env: { ...process.env, ...environment },
		})
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) accept()
			else reject(new Error(`${command} ${args.join(' ')} failed (${signal ?? code})`))
		})
	})
}
