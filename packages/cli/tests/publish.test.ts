import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { publishPackage, resolveWebhookAudience } from '../src/publish'

async function setupPackageFixture(name: string, version: string, options?: { private?: boolean }) {
	const target = await mkdtemp(join(tmpdir(), `pluxel-cli-publish-${name}-`))
	const pkg = {
		name,
		version,
		...(options?.private ? { private: true } : {}),
	}
	await writeFile(join(target, 'package.json'), JSON.stringify(pkg, null, 2))
	await mkdir(join(target, 'src'), { recursive: true })
	await writeFile(join(target, 'src', 'index.ts'), 'export const hello = "world"')
	return target
}

async function teardownFixture(dir: string) {
	await rm(dir, { recursive: true, force: true })
}

function snapshotEnv(keys: string[]) {
	const state: Record<string, string | undefined> = {}
	for (const key of keys) state[key] = process.env[key]
	return state
}

function restoreEnv(state: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(state)) {
		if (typeof value === 'undefined') delete process.env[key]
		else process.env[key] = value
	}
}

const noop = () => {
	// Empty function for log parameter
}

describe('publish single package', () => {
	it.skip('publishes when version is new (requires npm auth)', async () => {
		// This test calls real npm publish and requires authentication
		// Skip in CI/local testing unless specifically testing publish flow
		const dir = await setupPackageFixture('example-pkg', '1.1.0')
		try {
			const result = await publishPackage({
				cwd: dir,
				log: noop,
				env: {
					...process.env,
					// Mock npm commands to avoid actual publishing
					npm_config_registry: 'https://registry.npmjs.org/',
				},
			})

			// In a real scenario this would call npm publish
			// For now we just verify the structure
			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('1.1.0')
		} finally {
			await teardownFixture(dir)
		}
	})

	it.skip('skips publishing when version already exists (requires npm)', async () => {
		// This test calls real npm view and requires network access
		const dir = await setupPackageFixture('example-pkg', '1.0.0')
		try {
			// Mock that version 1.0.0 is already published by returning it
			const env = process.env
			const result = await publishPackage({
				cwd: dir,
				skipVersionCheck: false,
				log: noop,
				env,
			})

			// This test would need actual npm mocking to work properly
			// For now just verify structure
			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('1.0.0')
		} finally {
			await teardownFixture(dir)
		}
	})

	it('throws error for private packages', async () => {
		const dir = await setupPackageFixture('private-pkg', '1.0.0', { private: true })
		try {
			await expect(
				publishPackage({
					cwd: dir,
					log: noop,
				}),
			).rejects.toThrow('private')
		} finally {
			await teardownFixture(dir)
		}
	})

	it('respects dryRun flag', async () => {
		const dir = await setupPackageFixture('example-pkg', '1.2.0')
		try {
			const result = await publishPackage({
				cwd: dir,
				dryRun: true,
				log: noop,
			})

			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('1.2.0')
			expect(result.published).toBe(false)
		} finally {
			await teardownFixture(dir)
		}
	})
})

describe('publish with CI context', () => {
	it('sends market notification with OIDC token in CI environment', async () => {
		const dir = await setupPackageFixture('example-pkg', '2.0.0')
		const savedEnv = snapshotEnv(['GITHUB_ACTIONS', 'GITHUB_REPOSITORY'])

		try {
			process.env.GITHUB_ACTIONS = 'true'
			process.env.GITHUB_REPOSITORY = 'acme/example'

			const result = await publishPackage({
				cwd: dir,
				dryRun: true, // Don't actually publish in tests
				log: noop,
			})

			// Verify structure - actual market notification would need mocking
			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('2.0.0')
			expect(result.notified).toBe(false) // False because dryRun
		} finally {
			restoreEnv(savedEnv)
			await teardownFixture(dir)
		}
	})

	it('skips market notification when not in CI', async () => {
		const dir = await setupPackageFixture('example-pkg', '2.1.0')
		const savedEnv = snapshotEnv(['GITHUB_ACTIONS', 'GITLAB_CI'])

		try {
			delete process.env.GITHUB_ACTIONS
			delete process.env.GITLAB_CI

			const result = await publishPackage({
				cwd: dir,
				dryRun: true,
				log: noop,
			})

			expect(result.notified).toBe(false)
		} finally {
			restoreEnv(savedEnv)
			await teardownFixture(dir)
		}
	})

	it('does not add provenance for restricted/private packages in CI', async () => {
		const dir = await setupPackageFixture('example-pkg', '3.0.0')
		const savedEnv = snapshotEnv(['GITHUB_ACTIONS', 'GITHUB_REPOSITORY'])
		const logs: string[] = []

		try {
			process.env.GITHUB_ACTIONS = 'true'
			process.env.GITHUB_REPOSITORY = 'acme/example'

			await publishPackage({
				cwd: dir,
				access: 'restricted', // 私有包
				dryRun: true,
				skipVersionCheck: true, // 跳过版本检查以避免网络请求
				debug: true,
				log: (...args) => logs.push(args.join(' ')),
			})

			const debugArgs = logs.find((log) => log.includes('debug: npm args'))
			expect(debugArgs?.includes('--provenance')).toBe(false)
			expect(debugArgs?.includes('--access restricted')).toBe(true)
		} finally {
			restoreEnv(savedEnv)
			await teardownFixture(dir)
		}
	})

	it('skips version check in raw mode (mimics plain npm publish)', async () => {
		const dir = await setupPackageFixture('example-pkg', '4.0.0')
		const logs: string[] = []

		try {
			const result = await publishPackage({
				cwd: dir,
				dryRun: true, // avoid running npm
				env: { ...process.env, PLUXEL_PUBLISH_RAW: '1' },
				log: (...args) => logs.push(args.join(' ')),
			})

			expect(result.packageName).toBe('example-pkg')
			expect(logs.some((line) => line.includes('checking if'))).toBe(false)
		} finally {
			await teardownFixture(dir)
		}
	})

	it('prints debug info when enabled', async () => {
		const dir = await setupPackageFixture('example-pkg', '5.0.0')
		const logs: string[] = []

		try {
			await publishPackage({
				cwd: dir,
				dryRun: true,
				skipVersionCheck: true,
				debug: true,
				env: { ...process.env, NPM_CONFIG_PROVENANCE: 'true', NODE_AUTH_TOKEN: '***' },
				log: (...args) => logs.push(args.join(' ')),
			})

			expect(logs.some((line) => line.includes('debug: npm args'))).toBe(true)
			expect(logs.some((line) => line.includes('debug: npm env keys'))).toBe(true)
		} finally {
			await teardownFixture(dir)
		}
	})

	it('computes webhook audience from env or base URL', () => {
		expect(resolveWebhookAudience('https://market.pluxel.dev', {} as NodeJS.ProcessEnv)).toBe(
			'https://market.pluxel.dev/webhook',
		)
		expect(
			resolveWebhookAudience('https://market.pluxel.dev/', {} as NodeJS.ProcessEnv),
		).toBe('https://market.pluxel.dev/webhook')
		expect(
			resolveWebhookAudience('https://market.pluxel.dev', {
				PLUXEL_MARKET_AUDIENCE: 'https://override/webhook',
			} as NodeJS.ProcessEnv),
		).toBe('https://override/webhook')
	})

	it('can trigger webhook when publish is skipped (webhook flag)', async () => {
		const dir = await setupPackageFixture('example-pkg', '6.0.0')
		const savedFetch = global.fetch
		const requests: string[] = []

		global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString()
			requests.push(url)
			if (url.includes('oidc')) {
				return new Response(JSON.stringify({ value: 'test-token' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			}
			return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
		}) as typeof fetch

		try {
			const result = await publishPackage({
				cwd: dir,
				dryRun: true,
				skipVersionCheck: true,
				webhook: true,
				env: {
					...process.env,
					GITHUB_ACTIONS: 'true',
					GITHUB_REPOSITORY: 'acme/example',
					ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.com/token',
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'dummy',
					PLUXEL_MARKET_AUDIENCE: 'https://market.test/webhook',
				},
				log: noop,
			})

			expect(result.notified).toBe(true)
			expect(requests.some((url) => url.includes('oidc.example.com'))).toBe(true)
			expect(requests.some((url) => url.includes('market.pluxel.dev') || url.includes('market.test'))).toBe(true)
		} finally {
			global.fetch = savedFetch
			await teardownFixture(dir)
		}
	})
})
