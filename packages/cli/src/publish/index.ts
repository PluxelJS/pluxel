import { resolve } from 'pathe'
import { readPackageJSON, type PackageJson } from 'pkg-types'
import { detectCiContext } from '../ci/context'
import { resolveOidcToken } from '../ci/oidc'
import { CLI_DEFAULTS } from '../config'
import { runCommand } from '../utils/exec'
import { resolveMarketWebhookClient } from './market-rpc'

type Logger = (...args: unknown[]) => void
type ReadPackageJson = (path: string) => Promise<PackageJson>

const noop = () => {}

function isTruthyEnv(value: string | undefined) {
	if (!value) return false
	const normalized = value.trim().toLowerCase()
	return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

export function resolveWebhookAudience(baseUrl: string | undefined, env: NodeJS.ProcessEnv) {
	if (env.PLUXEL_MARKET_AUDIENCE?.trim()) return env.PLUXEL_MARKET_AUDIENCE.trim()
	if (env.PLUXEL_MARKET_WEBHOOK_AUDIENCE?.trim()) return env.PLUXEL_MARKET_WEBHOOK_AUDIENCE.trim()
	if (!baseUrl) return undefined
	const normalized = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
	return `${normalized}/webhook`
}

export interface PublishOptions {
	access?: string
	dryRun?: boolean
	skipVersionCheck?: boolean
	debug?: boolean
	webhook?: boolean
	log?: Logger
	cwd?: string
	env?: NodeJS.ProcessEnv
	readPackageJson?: ReadPackageJson
}

export interface PublishResult {
	packageName: string
	version: string
	published: boolean
	alreadyPublished?: boolean
	notified: boolean
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

	const result: PublishResult = {
		packageName: pkg.name,
		version: pkg.version,
		published: false,
		notified: false,
	}
	let skipPublish = false

	// 检查版本是否已发布（除非跳过）
	if (!rawPublish && !options.skipVersionCheck) {
		log(`[publish] checking if ${pkg.name}@${pkg.version} is already published...`)
		const publishedVersion = await getPublishedVersion(pkg.name, log, env)
		if (publishedVersion === pkg.version) {
			log(`[publish] ${pkg.name}@${pkg.version} already published, skipping`)
			result.alreadyPublished = true
			skipPublish = true
			if (!forceWebhook) return result
		}
		if (publishedVersion) {
			log(`[publish] current published version: ${publishedVersion}`)
		}
	}

	// 检测 CI 环境，在 CI 中使用 --provenance 启用 OIDC
	// 但只对公开包使用，私有包不支持 provenance
	const ciContext = detectCiContext(env)
	const shouldNotify =
		forceWebhook || (Boolean(ciContext) && options.dryRun !== true && !skipPublish)
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
		log(`[publish] publishing ${pkg.name}@${pkg.version}...`)
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

	// 发送 market webhook（如果在 CI 环境或强制开启）
	if (shouldNotify) {
		try {
			// 在 CI 环境自动获取 OIDC token
			const marketBaseUrl = CLI_DEFAULTS.publish.marketBaseUrl
			const audience = resolveWebhookAudience(marketBaseUrl, env)
			const oidcToken = await resolveOidcToken({
				required: forceWebhook,
				audience,
				log,
				env,
			})

			if (!oidcToken) {
				log('[publish] warn: skipping market notification (no OIDC token available)')
			} else {
				log(`[publish] notifying market at ${marketBaseUrl}...`)
				const rpcClient = await resolveMarketWebhookClient(marketBaseUrl, log)
				if (rpcClient) {
					await rpcClient.submit({ packageName: pkg.name, version: pkg.version }, oidcToken)
					log('[publish] ✓ market notified')
					result.notified = true
				} else {
					log('[publish] warn: market RPC client unavailable')
				}
			}
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			if (forceWebhook) {
				throw new Error(`[publish] market notification failed: ${reason}`, { cause: error })
			}
			log(`[publish] warn: market notification failed: ${reason}`)
		}
	} else {
		log('[publish] market notification skipped')
	}

	return result
}

async function getPublishedVersion(
	packageName: string,
	log: Logger,
	env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
	const res = await runCommand('npm', ['view', packageName, 'version', '--json'], {
		env,
	})

	if (res.code !== 0) {
		// 404 意味着包不存在，这是正常的
		if (res.stderr.includes('404') || res.stderr.includes('E404')) {
			return undefined
		}
		log(`[publish] warn: npm view ${packageName} exited with code ${res.code}`)
		return undefined
	}

	const output = res.stdout.trim() || res.stderr.trim()
	if (!output) return undefined

	try {
		const parsed = JSON.parse(output) as unknown
		if (typeof parsed === 'string') return parsed
		if (Array.isArray(parsed)) {
			// 如果返回数组，取最后一个版本
			for (let i = parsed.length - 1; i >= 0; i -= 1) {
				const value = parsed[i]
				if (typeof value === 'string') return value
			}
		}
	} catch {
		// 解析失败，尝试简单提取
	}

	const segments = output.split(/\s+/).filter(Boolean)
	return segments.length > 0 ? segments.at(-1) : undefined
}
