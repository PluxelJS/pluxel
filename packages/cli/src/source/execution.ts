import { createHash } from 'node:crypto'
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, relative, resolve } from 'pathe'
import { runCommand } from '../utils/exec'
import { normalizeRepositoryIdentity } from './config'
import {
	sourceCheckoutInstallOverrides,
	type ResolvedSourceCheckout,
	type SourceWorkspacePlan,
} from './plan'
import { sourcePackageNeedsBuild } from './workspace'

export interface SourcePlanDiagnostics {
	errors: string[]
	warnings: string[]
}

export async function diagnoseSourceWorkspacePlan(
	plan: SourceWorkspacePlan,
): Promise<SourcePlanDiagnostics> {
	const errors: string[] = []
	const warnings: string[] = []
	for (const checkout of plan.checkouts) {
		const actual = await discoverCheckoutRepository(checkout.root)
		if (!actual) {
			warnings.push(`Could not verify Git remote for ${checkout.repository} at ${checkout.root}`)
		} else if (actual !== checkout.repository) {
			errors.push(
				`Registered checkout has the wrong repository: expected ${checkout.repository}, found ${actual} at ${checkout.root}`,
			)
		}
	}
	return { errors, warnings }
}

export async function discoverCheckoutRepository(root: string): Promise<string | undefined> {
	const result = await runCommand('git', ['-C', root, 'remote', 'get-url', 'origin'])
	if (result.code === 0 && result.stdout.trim()) {
		return normalizeRepositoryIdentity(result.stdout.trim())
	}
	const manifestRepository = await readRootManifestRepository(root)
	return manifestRepository ? normalizeRepositoryIdentity(manifestRepository) : undefined
}

export async function installSourceWorkspace(options: {
	plan: SourceWorkspacePlan
	build: boolean
	log: (...args: unknown[]) => void
}) {
	for (const checkout of options.plan.checkouts) {
		const overrides = sourceCheckoutInstallOverrides(checkout, options.plan)
		options.log(`\n→ Installing source checkout ${checkout.repository}`)
		await runPnpmInstall(checkout.root, overrides, options.plan.checkouts)
		if (options.build) await buildSourceCheckout(checkout, options.plan, options.log)
	}
	options.log('\n→ Installing consumer workspace with source overlay')
	await runPnpmInstall(options.plan.root, options.plan.overrides, options.plan.checkouts)
}

export async function buildSourceWorkspace(options: {
	plan: SourceWorkspacePlan
	log: (...args: unknown[]) => void
}) {
	for (const checkout of options.plan.checkouts) {
		await buildSourceCheckout(checkout, options.plan, options.log)
	}
}

export function createSourceInstallArgs(overrides: Record<string, string>) {
	if (Object.keys(overrides).length === 0) return ['install', '--frozen-lockfile']
	return ['install']
}

export function createPnpmInvocation(packageManager: string | undefined, args: string[]) {
	if (packageManager && !packageManager.startsWith('pnpm@')) {
		throw new Error(`Source workspaces require pnpm, but packageManager is ${packageManager}`)
	}
	const version = packageManager?.slice('pnpm@'.length)
	const exactVersion = version && /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\w.-]+)?$/.test(version)
	return exactVersion ? { command: 'corepack', args: ['pnpm', ...args] } : { command: 'pnpm', args }
}

export function createSourceBuildArgs(packageNames: string[], hasTurbo: boolean) {
	return hasTurbo
		? ['exec', 'turbo', 'run', 'build', ...packageNames.map((name) => `--filter=${name}`)]
		: [
				...packageNames.flatMap((name) => ['--filter', `${name}...`]),
				'--if-present',
				'run',
				'build',
			]
}

async function runPnpmInstall(
	root: string,
	overrides: Record<string, string>,
	checkouts: ResolvedSourceCheckout[],
) {
	if (Object.keys(overrides).length > 0) {
		const stableOverrides = materializeSourceOverrides(root, overrides, checkouts)
		ensureSourcePnpmfileBootstrap(root)
		writeSourcePnpmfile(root, stableOverrides)
	}
	await runPnpm(createSourceInstallArgs(overrides), root)
}

export function materializeSourceOverrides(
	root: string,
	overrides: Record<string, string>,
	checkouts: ResolvedSourceCheckout[],
) {
	const stable: Record<string, string> = {}
	for (const [name, specifier] of Object.entries(overrides)) {
		if (!specifier.startsWith('link:')) throw new Error(`Unsupported source override: ${specifier}`)
		const sourcePackageDir = resolve(specifier.slice('link:'.length))
		const checkout = checkouts
			.filter((candidate) => isInside(candidate.root, sourcePackageDir))
			.sort((a, b) => b.root.length - a.root.length)[0]
		if (!checkout) throw new Error(`Source package ${name} is outside every declared checkout`)
		const checkoutLink = ensureCheckoutLink(root, checkout)
		const packagePath = relativePath(checkout.root, sourcePackageDir)
		stable[name] = `link:${relativePath(root, resolve(checkoutLink, packagePath))}`
	}
	return stable
}

export function writeSourcePnpmfile(root: string, overrides: Record<string, string>) {
	const path = resolve(root, '.pluxel/source-pnpmfile.cjs')
	const contents = [
		'// Generated by `pluxel source install`; machine-local and safe to delete.',
		`const sourceOverrides = ${JSON.stringify(overrides, null, 2)}`,
		'module.exports = {',
		'\thooks: {',
		'\t\tupdateConfig(config) {',
		'\t\t\tconfig.overrides = { ...config.overrides, ...sourceOverrides }',
		'\t\t\treturn config',
		'\t\t},',
		'\t},',
		'}',
		'',
	].join('\n')
	mkdirSync(dirname(path), { recursive: true })
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
	try {
		writeFileSync(temporary, contents, 'utf8')
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
	return path
}

export function ensureSourcePnpmfileBootstrap(root: string) {
	const path = resolve(root, '.pnpmfile.cjs')
	const marker = '// Generated by `pluxel source install`; commit this path-independent bootstrap.'
	if (existsSync(path)) {
		const current = readFileSync(path, 'utf8')
		if (current.includes(marker)) return path
		throw new Error(
			`Source workspace requires ${path}, but the project already owns a custom pnpmfile. ` +
				'Compose its hooks with .pluxel/source-pnpmfile.cjs explicitly.',
		)
	}
	const contents = [
		marker,
		"const { existsSync } = require('node:fs')",
		"const { resolve } = require('node:path')",
		"const generated = resolve(__dirname, '.pluxel/source-pnpmfile.cjs')",
		'module.exports = existsSync(generated) ? require(generated) : { hooks: {} }',
		'',
	].join('\n')
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
	try {
		writeFileSync(temporary, contents, 'utf8')
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
	return path
}

function ensureCheckoutLink(root: string, checkout: ResolvedSourceCheckout) {
	const id = createHash('sha256').update(checkout.repository).digest('hex').slice(0, 12)
	const linksRoot = resolve(root, '.pluxel/sources')
	const path = resolve(linksRoot, id)
	mkdirSync(linksRoot, { recursive: true })
	let stat: ReturnType<typeof lstatSync> | undefined
	try {
		stat = lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	if (stat) {
		if (!stat.isSymbolicLink()) {
			throw new Error(`Refusing to replace non-symlink source path: ${path}`)
		}
		const current = resolve(dirname(path), readlinkSync(path))
		if (current === resolve(checkout.root)) return path
		rmSync(path)
	}
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
	try {
		symlinkSync(
			resolve(checkout.root),
			temporary,
			process.platform === 'win32' ? 'junction' : 'dir',
		)
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
	return path
}

function isInside(root: string, path: string) {
	const rel = relativePath(root, path)
	return rel === '.' || (!rel.startsWith('../') && rel !== '..')
}

function relativePath(from: string, to: string) {
	return (relative(resolve(from), resolve(to)) || '.').replaceAll('\\', '/')
}

async function buildSourceCheckout(
	checkout: ResolvedSourceCheckout,
	plan: SourceWorkspacePlan,
	log: (...args: unknown[]) => void,
) {
	const targets = (plan.selectedByRepository.get(checkout.repository) ?? []).filter((pkg) =>
		sourcePackageNeedsBuild(pkg.manifest),
	)
	if (targets.length === 0) {
		log(`→ No build artifacts required from ${checkout.repository}`)
		return
	}
	log(`\n→ Building ${targets.map((pkg) => pkg.name).join(', ')} from ${checkout.repository}`)
	const hasTurbo =
		existsSync(resolve(checkout.root, 'turbo.json')) ||
		existsSync(resolve(checkout.root, 'turbo.jsonc'))
	const args = createSourceBuildArgs(
		targets.map((pkg) => pkg.name),
		hasTurbo,
	)
	await runPnpm(args, checkout.root, checkout.workspace.rootManifest.packageManager)
}

async function runPnpm(args: string[], cwd: string, packageManager = readPackageManager(cwd)) {
	const invocation = createPnpmInvocation(packageManager, args)
	await runInherited(invocation.command, invocation.args, cwd)
}

function readPackageManager(root: string) {
	const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
		packageManager?: unknown
	}
	if (manifest.packageManager !== undefined && typeof manifest.packageManager !== 'string') {
		throw new Error(`${resolve(root, 'package.json')}: packageManager must be a string`)
	}
	return manifest.packageManager
}

async function readRootManifestRepository(root: string) {
	try {
		const manifest = JSON.parse(
			await import('node:fs/promises').then((fs) =>
				fs.readFile(resolve(root, 'package.json'), 'utf8'),
			),
		) as { repository?: string | { url?: string } }
		return typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
	} catch {
		return undefined
	}
}

async function runInherited(command: string, args: string[], cwd: string) {
	const { spawn } = await import('node:child_process')
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: 'inherit',
			shell: process.platform === 'win32',
		})
		child.once('error', reject)
		child.once('exit', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`${command} ${args.join(' ')} failed in ${cwd}`))
		})
	})
}
