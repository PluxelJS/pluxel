import { resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'
import { readPackageJSON } from 'pkg-types'
import { CLI_DEFAULTS, resolvePublishEnv } from '../config'
import { detectCiContext, type CiContext } from '../ci/context'
import { resolveOidcToken } from '../ci/oidc'
import { runCommand } from '../utils/exec'
import { scanWorkspaceDirs } from '../workspace/scanner'
import { resolveMarketWebhookClient } from './market-rpc'

type Logger = (...args: unknown[]) => void

export interface PublishOptions {
	root?: string
	base?: string
	registry?: string
	webhook?: string
	dryRun?: boolean
	access?: string
	audience?: string
	requireOidc?: boolean
	log?: Logger
	resolvePublishedVersion?: PublishedVersionResolver
	publisher?: PackagePublisher
	notifier?: MarketplaceNotifier
	env?: NodeJS.ProcessEnv
	marketBaseUrl?: string
}

export interface PublishTarget {
	dir: string
	relativeDir: string
	name: string
	version: string
	publishedVersion?: string
}

export interface PublishResult {
	planned: PublishTarget[]
	published: PublishTarget[]
	notified: boolean
}

export type PublishedVersionResolver = (name: string) => Promise<string | undefined>
export type PackagePublisher = (target: PublishTarget, context: PublishContext) => Promise<void>
export type MarketplaceNotifier = (
	targets: PublishTarget[],
	context: PublishContext & { marketBaseUrl?: string },
) => Promise<void>

export interface PublishContext {
	registry?: string
	access?: string
	oidcToken?: string
	ciContext?: CiContext
	marketBaseUrl?: string
	log: Logger
}

export async function publishWorkspaces(options: PublishOptions): Promise<PublishResult> {
	const root = resolve(process.cwd(), options.root ?? '.')
	const log = options.log ?? (() => {})
	const env = options.env ?? process.env
	const envDefaults = resolvePublishEnv(env)
	const registry = options.registry ?? envDefaults.registry
	const marketBaseUrl =
		options.marketBaseUrl ??
		envDefaults.marketBaseUrl ??
		options.webhook ??
		envDefaults.webhook ??
		CLI_DEFAULTS.publish.marketBaseUrl
	const ciContext = detectCiContext(env)
	const shouldRequireOidc = options.requireOidc ?? CLI_DEFAULTS.publish.requireOidc
	const requireOidc = Boolean(ciContext && !options.dryRun && shouldRequireOidc)
	const access = options.access ?? CLI_DEFAULTS.publish.access
	const audience = options.audience ?? envDefaults.audience
	const baseDir = options.base ?? CLI_DEFAULTS.publish.base

	const shouldFetchOidc = requireOidc || Boolean(envDefaults.oidcToken)
	const oidcToken = shouldFetchOidc
		? await resolveOidcToken({
				required: requireOidc,
				audience,
				log,
				env,
				tokenEnvKey: CLI_DEFAULTS.publish.oidcTokenEnv,
			})
		: undefined

	const resolver =
		options.resolvePublishedVersion ?? ((name: string) => defaultPublishedVersionResolver(name, registry, log))
	const publisher =
		options.publisher ??
		((target: PublishTarget, context: PublishContext) =>
			defaultPackagePublisher(target, { ...context, registry, access }))
	const notifier =
		options.notifier ??
		((targets: PublishTarget[], context: PublishContext) =>
			defaultMarketplaceNotifier(targets, { ...context, marketBaseUrl }))

	const packages = await discoverPackages(root, baseDir, log)
	const planned: PublishTarget[] = []

	for (const pkg of packages) {
		if (!pkg.name || !pkg.version) {
			log(`[publish] skip ${pkg.relativeDir || pkg.dir} (missing name or version)`)
			continue
		}
		if (pkg.private) {
			log(`[publish] skip ${pkg.name} (private)`)
			continue
		}
		const publishedVersion = await resolver(pkg.name)
		if (publishedVersion === pkg.version) {
			log(`[publish] ${pkg.name}@${pkg.version} already published`)
			continue
		}
		planned.push({
			dir: pkg.dir,
			relativeDir: pkg.relativeDir,
			name: pkg.name,
			version: pkg.version,
			publishedVersion,
		})
	}

	if (planned.length === 0) {
		log('[publish] no packages to publish')
		return { planned, published: [], notified: false }
	}

	const published: PublishTarget[] = []
	for (const target of planned) {
		log(`[publish] ${options.dryRun ? '(dry-run) ' : ''}${target.name}@${target.version}`)
		if (options.dryRun) continue
		await publisher(target, { registry, access, oidcToken, ciContext, log })
		published.push(target)
	}

	let notified = false
	if (!options.dryRun && marketBaseUrl && ciContext && published.length > 0) {
		await notifier(published, {
			registry,
			access,
			oidcToken,
			ciContext,
			log,
			marketBaseUrl,
		})
		notified = true
	} else if (marketBaseUrl && !ciContext) {
		log('[publish] market RPC configured but CI provider not detected; skipping notify')
	}

	return { planned, published, notified }
}

interface DiscoveredPackage {
	dir: string
	relativeDir: string
	name?: string
	version?: string
	private?: boolean
}

async function discoverPackages(root: string, base: string | undefined, log: Logger) {
	const paths = await scanWorkspaceDirs(root, base)
	const packages: DiscoveredPackage[] = []

	for (const relativeDir of paths) {
		const dir = resolve(root, relativeDir)
		const pkgPath = resolve(dir, 'package.json')
		try {
			const pkg = await readPackageJSON(pkgPath)
			packages.push({
				dir,
				relativeDir,
				name: pkg.name,
				version: pkg.version,
				private: pkg.private === true,
			})
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			log(`[publish] warn: failed to read ${pkgPath}: ${reason}`)
		}
	}

	return packages
}

async function defaultPublishedVersionResolver(name: string, registry: string | undefined, log: Logger) {
	const args = ['view', name, 'version', '--json']
	if (registry) {
		args.push('--registry', registry)
	}
	const res = await runCommand('npm', args, { env: process.env })
	if (res.code !== 0) {
		log(`[publish] warn: npm view ${name} exited with code ${res.code ?? 'unknown'}`)
		return undefined
	}
	const output = res.stdout.trim() || res.stderr.trim()
	if (!output) return undefined

	try {
		const parsed = JSON.parse(output) as unknown
		if (typeof parsed === 'string') return parsed
		if (Array.isArray(parsed)) {
			for (let i = parsed.length - 1; i >= 0; i -= 1) {
				const value = parsed[i]
				if (typeof value === 'string') return value
			}
		}
	} catch {
		// fall through to best-effort parsing
	}

	const segments = output.split(/\s+/).filter(Boolean)
	return segments.length > 0 ? segments[segments.length - 1] : undefined
}

async function defaultPackagePublisher(target: PublishTarget, context: PublishContext) {
	const args = ['publish']
	if (context.registry) args.push('--registry', context.registry)
	if (context.access) args.push('--access', context.access)
	if (context.oidcToken) args.push('--provenance')
	const env = { ...process.env }
	if (context.registry) env.npm_config_registry = context.registry
	if (context.oidcToken) env.OIDC_TOKEN = context.oidcToken

	const res = await runCommand('npm', args, {
		cwd: target.dir,
		env,
	})
	if (res.code !== 0) {
		throw new Error(
			`[publish] npm publish failed for ${target.name}@${target.version}: ${res.stderr || res.stdout || res.code}`,
		)
	}
}

async function defaultMarketplaceNotifier(
	targets: PublishTarget[],
	context: PublishContext & { marketBaseUrl?: string },
) {
	const rpcClient = resolveMarketWebhookClient(context.marketBaseUrl, context.log)
	if (rpcClient) {
		if (!context.oidcToken) {
			context.log('[publish] warn: skipping market RPC notify because OIDC token is missing')
		} else {
			for (const target of targets) {
				await rpcClient.submit({ packageName: target.name, version: target.version }, context.oidcToken)
			}
			return
		}
	}

	context.log('[publish] warn: market RPC client unavailable; skipping notify')
}
