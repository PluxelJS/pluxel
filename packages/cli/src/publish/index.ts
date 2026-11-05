import { resolve } from 'pathe'
import { readPackageJSON, type PackageJson } from 'pkg-types'
import { detectCiContext } from '../ci/context'
import { CLI_DEFAULTS } from '../config'
import { runCommand } from '../utils/exec'
import { notifyMarket, parseMarketOrigin, type MarketNotification } from './market-notification'
import { publicNpmRegistry, resolvePublishTarget } from './registry'

type Logger = (...args: unknown[]) => void
type ReadPackageJson = (path: string) => Promise<PackageJson>

const noop = () => {}

function isTruthyEnv(value: string | undefined) {
	if (!value) return false
	const normalized = value.trim().toLowerCase()
	return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

export interface PublishOptions {
	access?: string
	dryRun?: boolean
	skipVersionCheck?: boolean
	debug?: boolean
	webhook?: boolean
	/** Market HTTP API origin. Defaults to the official market. */
	marketUrl?: string
	log?: Logger
	cwd?: string
	env?: NodeJS.ProcessEnv
	readPackageJson?: ReadPackageJson
}

export interface PublishResult {
	packageName: string
	version: string
	registry: string
	published: boolean
	alreadyPublished?: boolean
	notified: boolean
	/** An accepted notification receipt; acceptance does not mean the release was indexed. */
	notification?: MarketNotification
}

export async function publishPackage(options: PublishOptions): Promise<PublishResult> {
	const log = options.log ?? noop
	const cwd = options.cwd ?? process.cwd()
	const env = options.env ?? process.env
	const debug = options.debug ?? false
	const forceWebhook = options.webhook ?? false
	const rawPublish = isTruthyEnv(env.PLUXEL_PUBLISH_RAW)
	const access = rawPublish ? options.access : (options.access ?? CLI_DEFAULTS.publish.access)
	const readPackageJson = options.readPackageJson ?? readPackageJSON

	// 读取当前目录的 package.json
	const pkgPath = resolve(cwd, 'package.json')
	let pkg: PackageJson
	try {
		pkg = await readPackageJson(pkgPath)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to read package.json at ${pkgPath}: ${reason}`, {
			cause: error,
		})
	}

	if (!pkg.name) {
		throw new Error('package.json is missing "name" field')
	}
	if (!pkg.version) {
		throw new Error('package.json is missing "version" field')
	}
	if (pkg.private) {
		throw new Error(`Package ${pkg.name} is marked as private, cannot publish`)
	}

	const target = await resolvePublishTarget(pkg, { cwd, env, access })
	const privatePublication = target.registry !== publicNpmRegistry || target.access !== 'public'
	if (!options.dryRun && forceWebhook && privatePublication && options.marketUrl === undefined) {
		throw new Error(
			'Private registry or unconfirmed public access: --webhook requires an explicit --market-url; no notification was sent',
		)
	}
	const result: PublishResult = {
		packageName: pkg.name,
		version: pkg.version,
		registry: target.registry,
		published: false,
		notified: false,
	}
	let skipPublish = false

	// 检查版本是否已发布（除非跳过）
	if (!rawPublish && !options.skipVersionCheck) {
		log(`[publish] checking if ${pkg.name}@${pkg.version} is already published...`)
		const publishedVersion = await getPublishedVersion({
			name: pkg.name,
			version: pkg.version,
			registry: target.registry,
			cwd,
			env,
		})
		if (publishedVersion === pkg.version) {
			log(`[publish] ${pkg.name}@${pkg.version} already published, skipping`)
			result.alreadyPublished = true
			skipPublish = true
			if (!forceWebhook) return result
		}
	}

	const ciContext = detectCiContext(env)
	const shouldNotify =
		options.dryRun !== true &&
		(forceWebhook || (Boolean(ciContext) && !skipPublish && !privatePublication))
	const marketOrigin = shouldNotify
		? parseMarketOrigin(options.marketUrl ?? CLI_DEFAULTS.publish.marketBaseUrl)
		: undefined
	const marketToken = env.PLUXEL_MARKET_TOKEN
	if (marketOrigin && marketToken !== undefined) {
		if (options.marketUrl === undefined)
			throw new Error('PLUXEL_MARKET_TOKEN requires an explicit --market-url before publishing')
		if (!marketToken || /[^\x21-\x7e]/.test(marketToken))
			throw new TypeError('PLUXEL_MARKET_TOKEN must be a nonempty bearer token without whitespace')
	}
	const publishArgs = ['publish']
	if (access) {
		publishArgs.push('--access', access)
	}
	if (debug) {
		log(`[publish] debug: npm args: ${publishArgs.join(' ')}`)
		const envKeys = Object.keys(env ?? {}).filter((key) => {
			const upper = key.toUpperCase()
			return (
				upper.startsWith('NPM_CONFIG_') ||
				upper === 'NPM_TOKEN' ||
				upper === 'NODE_AUTH_TOKEN' ||
				upper === 'NPM_CONFIG_REGISTRY'
			)
		})
		log(`[publish] debug: npm env keys: ${envKeys.join(', ') || '(none)'}`)
	}

	// 执行 npm publish，让 npm 自己处理 registry、OIDC、provenance
	if (!skipPublish && !options.dryRun) {
		log(`[publish] publishing ${pkg.name}@${pkg.version} to ${target.registry}...`)
		const publishResult = await runCommand('npm', publishArgs, { cwd, env })

		if (publishResult.code !== 0) {
			throw new Error(
				`npm publish failed: ${publishResult.stderr || publishResult.stdout || `exit code ${publishResult.code}`}`,
			)
		}

		log(`[publish] ✓ ${pkg.name}@${pkg.version} published successfully`)
		result.published = true
	} else if (options.dryRun) {
		log(`[publish] (dry-run) would publish ${pkg.name}@${pkg.version}`)
	} else {
		log('[publish] npm publish skipped')
	}

	// npm owns publishing/provenance; the market owns the durable notification receipt.
	if (marketOrigin) {
		try {
			log(`[publish] notifying market at ${marketOrigin.origin}...`)
			result.notification = await notifyMarket(
				marketOrigin,
				{ registry: target.registry, name: pkg.name, version: pkg.version },
				marketToken,
			)
			result.notified = true
			const { receipt, url } = result.notification
			log(`[publish] market receipt: ${JSON.stringify(receipt)}`)
			log(`[publish] receipt URL: ${url}`)
			if (receipt.status === 'indexed') log('[publish] market release indexed')
			else if (receipt.status === 'failed')
				log(`[publish] warn: market indexing failed (${receipt.code}); inspect the receipt`)
			else log(`[publish] market notification ${receipt.status}; indexing is not complete`)
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			const state = result.published ? 'npm publish succeeded' : 'the npm release already exists'
			if (forceWebhook) {
				throw new Error(`[publish] ${state}, but market notification failed: ${reason}`, {
					cause: error,
				})
			}
			log(`[publish] warn: ${state}, but market notification failed: ${reason}`)
		}
	} else {
		log(
			privatePublication && ciContext && !options.dryRun
				? '[publish] automatic market notification skipped for this registry/access; explicitly choose --webhook and --market-url to notify'
				: '[publish] market notification skipped',
		)
	}

	return result
}

async function getPublishedVersion(input: {
	name: string
	version: string
	registry: string
	cwd: string
	env: NodeJS.ProcessEnv
}): Promise<string | undefined> {
	const { name, version, registry, cwd, env } = input
	const specifier = `${name}@${version}`
	const scope = name.startsWith('@') ? name.split('/')[0] : undefined
	// npm view does not apply package.publishConfig. Pin its read to the selected
	// publish registry, including npm's higher-priority scoped registry setting.
	const args = [
		'view',
		specifier,
		'version',
		'--json',
		`--registry=${registry}`,
		'--scope=',
		...(scope ? [`--${scope}:registry=${registry}`] : []),
	]
	const res = await runCommand('npm', args, {
		cwd,
		env,
	})

	if (res.code !== 0) {
		let errorCode: unknown
		try {
			errorCode = (JSON.parse(res.stdout) as { error?: { code?: unknown } }).error?.code
		} catch {}
		if (errorCode === 'E404') return undefined
		throw new Error(`npm view ${specifier} failed: ${res.stderr || res.stdout || res.code}`)
	}

	const output = res.stdout.trim() || res.stderr.trim()
	try {
		const parsed = JSON.parse(output) as unknown
		if (parsed === version) return version
	} catch {
		// A successful exact-version query must return that version as JSON.
	}
	throw new Error(`npm view ${specifier} returned an unexpected version response`)
}
