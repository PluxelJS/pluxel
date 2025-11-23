import { resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'
import { readPackageJSON } from 'pkg-types'
import { detectCiContext } from '../ci/context'
import { resolveOidcToken } from '../ci/oidc'
import { CLI_DEFAULTS } from '../config'
import { runCommand } from '../utils/exec'
import { resolveMarketWebhookClient } from './market-rpc'

type Logger = (...args: unknown[]) => void

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {}

export interface PublishOptions {
	access?: string
	dryRun?: boolean
	skipVersionCheck?: boolean
	log?: Logger
	cwd?: string
	env?: NodeJS.ProcessEnv
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
	const access = options.access ?? CLI_DEFAULTS.publish.access

	// 读取当前目录的 package.json
	const pkgPath = resolve(cwd, 'package.json')
	let pkg: PackageJson
	try {
		pkg = await readPackageJSON(pkgPath)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`Failed to read package.json at ${pkgPath}: ${reason}`)
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

	// 检查版本是否已发布（除非跳过）
	if (!options.skipVersionCheck) {
		log(`[publish] checking if ${pkg.name}@${pkg.version} is already published...`)
		const publishedVersion = await getPublishedVersion(pkg.name, log)
		if (publishedVersion === pkg.version) {
			log(`[publish] ${pkg.name}@${pkg.version} already published, skipping`)
			result.alreadyPublished = true
			return result
		}
		if (publishedVersion) {
			log(`[publish] current published version: ${publishedVersion}`)
		}
	}

	if (options.dryRun) {
		log(`[publish] (dry-run) would publish ${pkg.name}@${pkg.version}`)
		return result
	}

	// 执行 npm publish，让 npm 自己处理 registry、OIDC、provenance
	log(`[publish] publishing ${pkg.name}@${pkg.version}...`)
	const publishArgs = ['publish', '--access', access]
	const publishResult = await runCommand('npm', publishArgs, { cwd, env })

	if (publishResult.code !== 0) {
		throw new Error(
			`npm publish failed: ${publishResult.stderr || publishResult.stdout || `exit code ${publishResult.code}`}`,
		)
	}

	log(`[publish] ✓ ${pkg.name}@${pkg.version} published successfully`)
	result.published = true

	// 发送 market webhook（如果在 CI 环境）
	const ciContext = detectCiContext(env)
	if (ciContext) {
		try {
			// 在 CI 环境自动获取 OIDC token
			const oidcToken = await resolveOidcToken({
				required: false,
				log,
				env,
			})

			if (!oidcToken) {
				log('[publish] warn: skipping market notification (no OIDC token available)')
			} else {
				const marketBaseUrl = CLI_DEFAULTS.publish.marketBaseUrl
				log(`[publish] notifying market at ${marketBaseUrl}...`)
				const rpcClient = resolveMarketWebhookClient(marketBaseUrl, log)
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
			log(`[publish] warn: market notification failed: ${reason}`)
		}
	} else {
		log('[publish] market notification skipped (not in CI environment)')
	}

	return result
}

async function getPublishedVersion(packageName: string, log: Logger): Promise<string | undefined> {
	const res = await runCommand('npm', ['view', packageName, 'version', '--json'], {
		env: process.env,
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
	return segments.length > 0 ? segments[segments.length - 1] : undefined
}
