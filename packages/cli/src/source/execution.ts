import { createHash } from 'node:crypto'
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve } from 'pathe'
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
	options: { checkOverlay?: boolean } = {},
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
	if (options.checkOverlay !== false) {
		for (const checkout of plan.checkouts) {
			const overrides = sourceCheckoutInstallOverrides(checkout, plan)
			if (Object.keys(overrides).length > 0) {
				diagnoseSourceOverlay(checkout.root, overrides, plan.checkouts, errors)
			}
		}
		diagnoseSourceOverlay(plan.root, plan.overrides, plan.checkouts, errors)
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
	const releaseLocks = acquireSourceInstallLocks([
		options.plan.root,
		...options.plan.checkouts.map((checkout) => checkout.root),
	])
	try {
		await Promise.all(
			[options.plan.root, ...options.plan.checkouts.map((checkout) => checkout.root)].map(
				ensureSourceBootstrapIgnored,
			),
		)
		for (const level of options.plan.executionLevels) {
			await Promise.all(
				level.map(async (checkout) => {
					const overrides = sourceCheckoutInstallOverrides(checkout, options.plan)
					options.log(`\n→ Installing source checkout ${checkout.repository}`)
					await runPnpmInstall(
						checkout.root,
						overrides,
						options.plan.checkouts,
						options.frozenLockfile,
					)
					if (options.build) await buildSourceCheckout(checkout, options.plan, options.log)
				}),
			)
		}
		options.log('\n→ Installing consumer workspace with source overlay')
		await runPnpmInstall(
			options.plan.root,
			options.plan.overrides,
			options.plan.checkouts,
			options.frozenLockfile,
		)
	} finally {
		releaseLocks()
	}
}

async function ensureSourceBootstrapIgnored(root: string) {
	const result = await runCommand('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'])
	if (result.code !== 0 || !result.stdout.trim()) return
	const rawPath = result.stdout.trim()
	const path = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath)
	const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
	if (current.split(/\r?\n/).includes('.pnpmfile.cjs')) return
	writeFileAtomic(
		path,
		`${current}${current && !current.endsWith('\n') ? '\n' : ''}.pnpmfile.cjs\n`,
	)
}

export async function buildSourceWorkspace(options: {
	plan: SourceWorkspacePlan
	packages?: readonly string[]
	force?: boolean
	log: (...args: unknown[]) => void
}) {
	if (options.packages && options.packages.length > 0) {
		const targets = selectSourceBuildTargets(options.plan, options.packages)
		const targetNames = new Set(targets.map((target) => target.name))
		for (const level of options.plan.executionLevels) {
			await Promise.all(
				level.map(async (checkout) => {
					const selected = (
						options.plan.selectedByRepository.get(checkout.repository) ?? []
					).filter((pkg) => targetNames.has(pkg.name))
					if (selected.length === 0) return
					await buildSourceCheckout(checkout, options.plan, options.log, selected, options.force)
				}),
			)
		}
		return
	}
	for (const level of options.plan.executionLevels) {
		await Promise.all(
			level.map((checkout) =>
				buildSourceCheckout(checkout, options.plan, options.log, undefined, options.force),
			),
		)
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
	return frozenLockfile ? ['install', '--frozen-lockfile'] : ['install']
}

export function createPnpmInvocation(packageManager: string | undefined, args: string[]) {
	if (packageManager && !packageManager.startsWith('pnpm@')) {
		throw new Error(`Source workspaces require pnpm, but packageManager is ${packageManager}`)
	}
	const version = packageManager?.slice('pnpm@'.length)
	const exactVersion = version && /^\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\w.-]+)?$/.test(version)
	return exactVersion ? { command: 'corepack', args: ['pnpm', ...args] } : { command: 'pnpm', args }
}

export function createSourceBuildArgs(packageNames: string[], hasTurbo: boolean, force = false) {
	return hasTurbo
		? [
				'exec',
				'turbo',
				'run',
				'build',
				...(force ? ['--force'] : []),
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
		const checkout = findOwningCheckout(checkouts, sourcePackageDir)
		if (!checkout) throw new Error(`Source package ${name} is outside every declared checkout`)
		const sourceLink = ensureSourceTargetLink(root, checkout, name, sourcePackageDir)
		const repositoryRoot = dirname(sourceLink)
		const desired = desiredLinks.get(repositoryRoot) ?? new Set<string>()
		desired.add(basename(sourceLink))
		desiredLinks.set(repositoryRoot, desired)
		stable[name] = `link:${relativePath(root, sourceLink)}`
	}
	pruneStaleSourceTargetLinks(root, desiredLinks)
	return stable
}

function diagnoseSourceOverlay(
	root: string,
	overrides: Record<string, string>,
	checkouts: ResolvedSourceCheckout[],
	errors: string[],
) {
	const bootstrap = resolve(root, '.pnpmfile.cjs')
	if (!existsSync(bootstrap)) {
		errors.push(`Source overlay is not installed in ${root}; run \`pluxel source install\``)
		return
	}
	if (readFileSync(bootstrap, 'utf8') !== sourcePnpmfileBootstrapContents()) {
		errors.push(`Source overlay bootstrap is stale or custom: ${bootstrap}`)
	}

	const stable = expectedStableOverrides(root, overrides, checkouts, errors)
	const generated = resolve(root, '.pluxel/source-pnpmfile.cjs')
	if (!existsSync(generated)) {
		errors.push(`Source overlay config is missing: ${generated}`)
	} else if (readFileSync(generated, 'utf8') !== sourcePnpmfileContents(stable)) {
		errors.push(`Source overlay config does not match the current package closure: ${generated}`)
	}
}

function expectedStableOverrides(
	root: string,
	overrides: Record<string, string>,
	checkouts: ResolvedSourceCheckout[],
	errors: string[],
) {
	const stable: Record<string, string> = {}
	const expectedPaths = new Set<string>()
	for (const [name, specifier] of Object.entries(overrides)) {
		if (!specifier.startsWith('link:')) {
			errors.push(`Unsupported source override: ${specifier}`)
			continue
		}
		const sourcePackageDir = resolve(specifier.slice('link:'.length))
		const checkout = findOwningCheckout(checkouts, sourcePackageDir)
		if (!checkout) {
			errors.push(`Source package ${name} is outside every declared checkout`)
			continue
		}
		const path = sourceTargetPath(root, checkout, name)
		expectedPaths.add(path)
		stable[name] = `link:${relativePath(root, path)}`
		let stat: ReturnType<typeof lstatSync> | undefined
		try {
			stat = lstatSync(path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
		if (!stat?.isSymbolicLink()) {
			errors.push(`Source package proxy is missing: ${path}`)
			continue
		}
		const actual = resolve(dirname(path), readlinkSync(path))
		const expectedTarget = existsSync(sourcePackageDir)
			? realpathSync(sourcePackageDir)
			: sourcePackageDir
		if (actual !== expectedTarget) {
			errors.push(`Source package proxy is stale: ${path} -> ${actual}`)
		}
	}
	for (const path of findUnexpectedSourceProxyPaths(root, expectedPaths)) {
		errors.push(`Stale source package proxy: ${path}`)
	}
	return stable
}

export function writeSourcePnpmfile(root: string, overrides: Record<string, string>) {
	const path = resolve(root, '.pluxel/source-pnpmfile.cjs')
	const contents = sourcePnpmfileContents(overrides)
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

function sourcePnpmfileContents(overrides: Record<string, string>) {
	return [
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
}

export function ensureSourcePnpmfileBootstrap(root: string) {
	const path = resolve(root, '.pnpmfile.cjs')
	const marker = '// Generated by `pluxel source install`; machine-local and safe to delete.'
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
	marker = '// Generated by `pluxel source install`; machine-local and safe to delete.',
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

	const linksRoot = resolve(root, '.pluxel/sources')
	const path = sourceTargetPath(root, checkout, name)
	const repositoryRoot = dirname(path)
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

function sourceTargetPath(root: string, checkout: ResolvedSourceCheckout, name: string) {
	const repositoryId = createHash('sha256').update(checkout.repository).digest('hex').slice(0, 12)
	const packageHash = createHash('sha256').update(name).digest('hex').slice(0, 12)
	const packageSlug = name.replace(/^@/, '').replaceAll('/', '+')
	return resolve(root, '.pluxel/sources', repositoryId, `${packageSlug}-${packageHash}`)
}

function findOwningCheckout(checkouts: ResolvedSourceCheckout[], sourcePackageDir: string) {
	return checkouts
		.filter((candidate) => isInside(candidate.root, sourcePackageDir))
		.sort((a, b) => b.root.length - a.root.length)[0]
}

function pruneStaleSourceTargetLinks(
	root: string,
	desiredLinks: ReadonlyMap<string, ReadonlySet<string>>,
) {
	const expected = new Set(
		[...desiredLinks].flatMap(([repositoryRoot, names]) =>
			[...names].map((name) => resolve(repositoryRoot, name)),
		),
	)
	for (const path of findUnexpectedSourceProxyPaths(root, expected)) {
		const stat = lstatSync(path)
		if (!stat.isSymbolicLink()) {
			throw new Error(`Refusing to remove non-symlink stale source path: ${path}`)
		}
		rmSync(path)
	}
}

function findUnexpectedSourceProxyPaths(root: string, expected: ReadonlySet<string>) {
	const linksRoot = resolve(root, '.pluxel/sources')
	if (!existsSync(linksRoot)) return []
	const unexpected: string[] = []
	for (const repository of readdirSync(linksRoot, { withFileTypes: true })) {
		const repositoryRoot = resolve(linksRoot, repository.name)
		if (!repository.isDirectory()) {
			if (!expected.has(repositoryRoot)) unexpected.push(repositoryRoot)
			continue
		}
		for (const entry of readdirSync(repositoryRoot, { withFileTypes: true })) {
			const path = resolve(repositoryRoot, entry.name)
			if (!expected.has(path)) unexpected.push(path)
		}
	}
	return unexpected.sort()
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
	force = false,
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
		force,
	)
	await runPnpm(args, checkout.root, checkout.workspace.rootManifest.packageManager)
}

function acquireSourceInstallLocks(roots: string[]): () => void {
	const locks: Array<{ descriptor: number; path: string }> = []
	try {
		for (const root of [...new Set(roots.map((candidate) => resolve(candidate)))].sort()) {
			const directory = resolve(root, '.pluxel')
			const path = resolve(directory, 'source-install.lock')
			mkdirSync(directory, { recursive: true })
			let descriptor: number
			try {
				descriptor = openSync(path, 'wx', 0o600)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
					throw new Error(`Another source install owns ${path}`)
				}
				throw error
			}
			writeFileSync(descriptor, `${process.pid}\n`, 'utf8')
			locks.push({ descriptor, path })
		}
	} catch (error) {
		releaseSourceInstallLocks(locks)
		throw error
	}
	return () => releaseSourceInstallLocks(locks)
}

function releaseSourceInstallLocks(locks: Array<{ descriptor: number; path: string }>) {
	for (const lock of locks.reverse()) {
		closeSync(lock.descriptor)
		try {
			unlinkSync(lock.path)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
		}
	}
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
