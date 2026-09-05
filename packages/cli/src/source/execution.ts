import { createHash } from 'node:crypto'
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, relative, resolve } from 'pathe'
import { runCommand } from '../utils/exec'
import { normalizeRepositoryIdentity } from './config'
import {
	sourceCheckoutInstallOverrides,
	type ResolvedSourceCheckout,
	type SourceWorkspacePlan,
} from './plan'
import { sourcePackageNeedsBuild, type SourceWorkspacePackage } from './workspace'

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
	frozenLockfile: boolean
	log: (...args: unknown[]) => void
}) {
	for (const checkout of options.plan.checkouts) {
		const overrides = sourceCheckoutInstallOverrides(checkout, options.plan)
		options.log(`\n→ Installing source checkout ${checkout.repository}`)
		await runPnpmInstall(checkout.root, overrides, options.plan.checkouts, options.frozenLockfile)
		if (options.build) await buildSourceCheckout(checkout, options.plan, options.log)
	}
	options.log('\n→ Installing consumer workspace with source overlay')
	await runPnpmInstall(
		options.plan.root,
		options.plan.overrides,
		options.plan.checkouts,
		options.frozenLockfile,
	)
}

export async function buildSourceWorkspace(options: {
	plan: SourceWorkspacePlan
	packages?: readonly string[]
	log: (...args: unknown[]) => void
}) {
	if (options.packages && options.packages.length > 0) {
		const targets = selectSourceBuildTargets(options.plan, options.packages)
		const targetNames = new Set(targets.map((target) => target.name))
		for (const checkout of options.plan.checkouts) {
			const selected = (options.plan.selectedByRepository.get(checkout.repository) ?? []).filter(
				(pkg) => targetNames.has(pkg.name),
			)
			if (selected.length === 0) continue
			await buildSourceCheckout(checkout, options.plan, options.log, selected)
		}
		return
	}
	for (const checkout of options.plan.checkouts) {
		await buildSourceCheckout(checkout, options.plan, options.log)
	}
}

/**
 * Select explicit build artifacts from the source closure without widening it to every linked
 * package. The selected package's own Turbo/pnpm task graph remains the authority for its build
 * prerequisites.
 */
export function selectSourceBuildTargets(
	plan: Pick<SourceWorkspacePlan, 'selectedPackages'>,
	packageNames: readonly string[],
): SourceWorkspacePackage[] {
	const packages = new Map(plan.selectedPackages.map((pkg) => [pkg.name, pkg]))
	const targets: SourceWorkspacePackage[] = []
	for (const name of new Set(packageNames)) {
		const pkg = packages.get(name)
		if (!pkg) {
			throw new Error(
				`Source build target ${name} is not selected by this consumer's source dependency closure`,
			)
		}
		if (!sourcePackageNeedsBuild(pkg.manifest)) {
			throw new Error(`Source build target ${name} does not expose a required build artifact`)
		}
		targets.push(pkg)
	}
	return targets
}

export function createSourceInstallArgs(overrides: Record<string, string>, frozenLockfile = false) {
	if (frozenLockfile || Object.keys(overrides).length === 0) {
		return ['install', '--frozen-lockfile']
	}
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
		? [
				'exec',
				'turbo',
				'run',
				'build',
				// Source overlays live outside the consumer workspace, so a consumer cache key cannot
				// prove their restored output directories are exact. Execute the selected source builds;
				// their own build tools clean outputs before emitting the linked artifacts.
				'--force',
				// The source orchestrator already selected pnpm for this checkout. Turbo otherwise
				// rejects valid devEngines ranges such as "pnpm@>=11 <12" as non-exact specs.
				'--dangerously-disable-package-manager-check',
				...packageNames.map((name) => `--filter=${name}`),
			]
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
	frozenLockfile: boolean,
) {
	if (Object.keys(overrides).length > 0) {
		const stableOverrides = materializeSourceOverrides(root, overrides, checkouts)
		ensureSourcePnpmfileBootstrap(root)
		writeSourcePnpmfile(root, stableOverrides)
	}
	await runPnpm(createSourceInstallArgs(overrides, frozenLockfile), root)
}

export function materializeSourceOverrides(
	root: string,
	overrides: Record<string, string>,
	checkouts: ResolvedSourceCheckout[],
) {
	const stable: Record<string, string> = {}
	const desiredLinks = new Map<string, Set<string>>()
	for (const [name, specifier] of Object.entries(overrides)) {
		if (!specifier.startsWith('link:')) throw new Error(`Unsupported source override: ${specifier}`)
		const sourcePackageDir = resolve(specifier.slice('link:'.length))
		const checkout = checkouts
			.filter((candidate) => isInside(candidate.root, sourcePackageDir))
			.sort((a, b) => b.root.length - a.root.length)[0]
		if (!checkout) throw new Error(`Source package ${name} is outside every declared checkout`)
		const sourceLink = ensureSourceTargetLink(root, checkout, name, sourcePackageDir)
		const repositoryRoot = dirname(sourceLink)
		const desired = desiredLinks.get(repositoryRoot) ?? new Set<string>()
		desired.add(basename(sourceLink))
		desiredLinks.set(repositoryRoot, desired)
		stable[name] = `link:${relativePath(root, sourceLink)}`
	}
	pruneStaleSourceTargetLinks(desiredLinks)
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
	const contents = sourcePnpmfileBootstrapContents(marker)
	if (existsSync(path)) {
		const current = readFileSync(path, 'utf8')
		if (current === contents) return path
		if (current.includes(marker)) {
			writeFileAtomic(path, contents)
			return path
		}
		throw new Error(
			`Source workspace requires ${path}, but the project already owns a custom pnpmfile. ` +
				'Compose its hooks with .pluxel/source-pnpmfile.cjs explicitly.',
		)
	}
	writeFileAtomic(path, contents)
	return path
}

export function sourcePnpmfileBootstrapContents(
	marker = '// Generated by `pluxel source install`; commit this path-independent bootstrap.',
) {
	return [
		marker,
		"const { existsSync } = require('node:fs')",
		"const { resolve } = require('node:path')",
		"const generated = resolve(__dirname, '.pluxel/source-pnpmfile.cjs')",
		'if (!existsSync(generated)) {',
		'\tthrow new Error(',
		"\t\t'Source overlay is missing. Run `pluxel source install` from an independently installed CLI.',",
		'\t)',
		'}',
		'module.exports = require(generated)',
		'',
	].join('\n')
}

function writeFileAtomic(path: string, contents: string) {
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
	try {
		writeFileSync(temporary, contents, 'utf8')
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
}

function ensureSourceTargetLink(
	root: string,
	checkout: ResolvedSourceCheckout,
	name: string,
	sourcePackageDir: string,
) {
	const consumerRoot = realpathSync(root)
	const target = realpathSync(sourcePackageDir)
	if (isInside(target, consumerRoot)) {
		throw new Error(
			`Source package ${name} contains the consumer workspace and cannot be linked safely: ${target} -> ${consumerRoot}`,
		)
	}

	const repositoryId = createHash('sha256').update(checkout.repository).digest('hex').slice(0, 12)
	const packageHash = createHash('sha256').update(name).digest('hex').slice(0, 12)
	const packageSlug = name.replace(/^@/, '').replaceAll('/', '+')
	const packageId = `${packageSlug}-${packageHash}`
	const linksRoot = resolve(root, '.pluxel/sources')
	const repositoryRoot = resolve(linksRoot, repositoryId)
	mkdirSync(linksRoot, { recursive: true })

	let repositoryStat: ReturnType<typeof lstatSync> | undefined
	try {
		repositoryStat = lstatSync(repositoryRoot)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
	if (repositoryStat?.isSymbolicLink()) {
		// Migrate the v1 whole-checkout proxy to package-granular links.
		rmSync(repositoryRoot)
	} else if (repositoryStat && !repositoryStat.isDirectory()) {
		throw new Error(`Refusing to replace non-directory source path: ${repositoryRoot}`)
	}
	mkdirSync(repositoryRoot, { recursive: true })

	const path = resolve(repositoryRoot, packageId)
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
		if (current === target) return path
		rmSync(path)
	}
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
	try {
		symlinkSync(target, temporary, process.platform === 'win32' ? 'junction' : 'dir')
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
	return path
}

function pruneStaleSourceTargetLinks(desiredLinks: ReadonlyMap<string, ReadonlySet<string>>) {
	for (const [repositoryRoot, desired] of desiredLinks) {
		for (const entry of readdirSync(repositoryRoot, { withFileTypes: true })) {
			if (desired.has(entry.name)) continue
			const path = resolve(repositoryRoot, entry.name)
			if (!entry.isSymbolicLink()) {
				throw new Error(`Refusing to remove non-symlink stale source path: ${path}`)
			}
			rmSync(path)
		}
	}
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
	selected?: readonly SourceWorkspacePackage[],
) {
	const targets = (selected ?? plan.selectedByRepository.get(checkout.repository) ?? []).filter(
		(pkg) => sourcePackageNeedsBuild(pkg.manifest),
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

function readPackageManager(root: string): string | undefined {
	const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
		packageManager?: unknown
	}
	const packageManager = manifest.packageManager
	if (packageManager !== undefined && typeof packageManager !== 'string') {
		throw new Error(`${resolve(root, 'package.json')}: packageManager must be a string`)
	}
	return packageManager as string | undefined
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
			env: sourceChildEnvironment(),
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

function sourceChildEnvironment(): NodeJS.ProcessEnv {
	const env = { ...process.env }
	// A source checkout owns package-manager selection independently from the consumer. Keeping the
	// consumer's marker makes pnpm think Corepack already pinned it and prevents nested exact
	// packageManager declarations from switching versions.
	delete env.COREPACK_ROOT
	return env
}
