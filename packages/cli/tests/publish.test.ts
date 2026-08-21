import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFixture, type TestFixture } from '@pluxel/test/fixtures'

vi.mock('../src/utils/exec', () => ({
	runCommand: vi.fn(),
}))

async function getPublish() {
	return await import('../src/publish')
}

async function getRunCommand() {
	const { runCommand } = await import('../src/utils/exec')
	return vi.mocked(runCommand)
}

function buildPackageTree(name: string, version: string, options?: { private?: boolean }) {
	const pkg = {
		name,
		version,
		...(options?.private ? { private: true } : {}),
	}
	return {
		'package.json': JSON.stringify(pkg, null, 2),
		'src/index.ts': 'export const hello = "world"\n',
	}
}

async function withPackageFixture<T>(
	name: string,
	version: string,
	options: { private?: boolean } | undefined,
	run: (fixture: TestFixture) => Promise<T>,
) {
	await using fixture = await createFixture(buildPackageTree(name, version, options))
	return await run(fixture)
}

function readPackageJsonFrom(fixture: TestFixture) {
	return async (path: string) => JSON.parse(String(await fixture.fsp.readFile(path, 'utf8')))
}

const noop = () => {
	// Empty function for log parameter
}

beforeEach(() => {
	vi.clearAllMocks()
})

function cleanCiEnv(env: NodeJS.ProcessEnv = process.env) {
	const next = { ...env }
	delete next.CI
	delete next.GITHUB_ACTIONS
	delete next.GITHUB_REPOSITORY
	delete next.ACTIONS_ID_TOKEN_REQUEST_URL
	delete next.ACTIONS_ID_TOKEN_REQUEST_TOKEN
	delete next.GITLAB_CI
	delete next.CI_PROJECT_PATH
	delete next.CI_SERVER_HOST
	return next
}

describe('publish single package', () => {
	it('publishes when version is new', async () => {
		await withPackageFixture('example-pkg', '1.1.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const rc = await getRunCommand()
			rc.mockImplementation(async (_command, args) => {
				if (args[0] === 'view') return { code: 1, stdout: '', stderr: 'E404' }
				if (args[0] === 'publish') return { code: 0, stdout: '', stderr: '' }
				return { code: 1, stdout: '', stderr: `unexpected npm args: ${args.join(' ')}` }
			})

			const result = await publishPackage({
				cwd: fixture.path,
				log: noop,
				env: cleanCiEnv(process.env),
				readPackageJson: readPackageJsonFrom(fixture),
			})

			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('1.1.0')
			expect(result.published).toBe(true)
			expect(rc).toHaveBeenCalledTimes(2)
		})
	})

	it('skips publishing when version already exists', async () => {
		await withPackageFixture('example-pkg', '1.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const rc = await getRunCommand()
			rc.mockResolvedValue({ code: 0, stdout: JSON.stringify('1.0.0'), stderr: '' })

			const result = await publishPackage({
				cwd: fixture.path,
				skipVersionCheck: false,
				log: noop,
				env: cleanCiEnv(process.env),
				readPackageJson: readPackageJsonFrom(fixture),
			})

			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('1.0.0')
			expect(result.published).toBe(false)
			expect(result.alreadyPublished).toBe(true)
			expect(rc).toHaveBeenCalledTimes(1)
		})
	})

	it('throws error for private packages', async () => {
		await withPackageFixture('private-pkg', '1.0.0', { private: true }, async (fixture) => {
			const { publishPackage } = await getPublish()
			await expect(
				publishPackage({
					cwd: fixture.path,
					log: noop,
					readPackageJson: readPackageJsonFrom(fixture),
				}),
			).rejects.toThrow('private')
		})
	})

	it('respects dryRun flag', async () => {
		await withPackageFixture('example-pkg', '1.2.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const result = await publishPackage({
				cwd: fixture.path,
				dryRun: true,
				skipVersionCheck: true,
				log: noop,
				readPackageJson: readPackageJsonFrom(fixture),
			})

			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('1.2.0')
			expect(result.published).toBe(false)
		})
	})
})

describe('publish with CI context', () => {
	it('does not notify market during dry-run even in CI', async () => {
		await withPackageFixture('example-pkg', '2.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const result = await publishPackage({
				cwd: fixture.path,
				dryRun: true,
				skipVersionCheck: true,
				env: {
					...process.env,
					GITHUB_ACTIONS: 'true',
					GITHUB_REPOSITORY: 'acme/example',
				},
				log: noop,
				readPackageJson: readPackageJsonFrom(fixture),
			})

			expect(result.packageName).toBe('example-pkg')
			expect(result.version).toBe('2.0.0')
			expect(result.notified).toBe(false)
		})
	})

	it('skips market notification when not in CI', async () => {
		await withPackageFixture('example-pkg', '2.1.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const env = { ...process.env }
			delete env.GITHUB_ACTIONS
			delete env.GITHUB_REPOSITORY
			delete env.GITLAB_CI
			delete env.CI_PROJECT_PATH

			const result = await publishPackage({
				cwd: fixture.path,
				dryRun: true,
				skipVersionCheck: true,
				env,
				log: noop,
				readPackageJson: readPackageJsonFrom(fixture),
			})

			expect(result.notified).toBe(false)
		})
	})

	it('does not add provenance for restricted/private packages in CI', async () => {
		const logs: string[] = []

		await withPackageFixture('example-pkg', '3.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			await publishPackage({
				cwd: fixture.path,
				access: 'restricted', // 私有包
				dryRun: true,
				skipVersionCheck: true, // 跳过版本检查以避免网络请求
				debug: true,
				env: {
					...process.env,
					GITHUB_ACTIONS: 'true',
					GITHUB_REPOSITORY: 'acme/example',
				},
				log: (...args) => logs.push(args.join(' ')),
				readPackageJson: readPackageJsonFrom(fixture),
			})

			const debugArgs = logs.find((log) => log.includes('debug: npm args'))
			expect(debugArgs?.includes('--provenance')).toBe(false)
			expect(debugArgs?.includes('--access restricted')).toBe(true)
		})
	})

	it('skips version check in raw mode (mimics plain npm publish)', async () => {
		const logs: string[] = []

		await withPackageFixture('example-pkg', '4.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const result = await publishPackage({
				cwd: fixture.path,
				dryRun: true, // avoid running npm
				env: { ...process.env, PLUXEL_PUBLISH_RAW: '1' },
				log: (...args) => logs.push(args.join(' ')),
				readPackageJson: readPackageJsonFrom(fixture),
			})

			expect(result.packageName).toBe('example-pkg')
			expect(logs.some((line) => line.includes('checking if'))).toBe(false)
		})
	})

	it('prints debug info when enabled', async () => {
		const logs: string[] = []

		await withPackageFixture('example-pkg', '5.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			await publishPackage({
				cwd: fixture.path,
				dryRun: true,
				skipVersionCheck: true,
				debug: true,
				env: { ...process.env, NPM_CONFIG_PROVENANCE: 'true', NODE_AUTH_TOKEN: '***' },
				log: (...args) => logs.push(args.join(' ')),
				readPackageJson: readPackageJsonFrom(fixture),
			})

			expect(logs.some((line) => line.includes('debug: npm args'))).toBe(true)
			expect(logs.some((line) => line.includes('debug: npm env keys'))).toBe(true)
		})
	})

	it('computes webhook audience from env or base URL', async () => {
		const { resolveWebhookAudience } = await getPublish()
		expect(resolveWebhookAudience('https://market.pluxel.dev', {} as NodeJS.ProcessEnv)).toBe(
			'https://market.pluxel.dev/webhook',
		)
		expect(resolveWebhookAudience('https://market.pluxel.dev/', {} as NodeJS.ProcessEnv)).toBe(
			'https://market.pluxel.dev/webhook',
		)
		expect(
			resolveWebhookAudience('https://market.pluxel.dev', {
				PLUXEL_MARKET_AUDIENCE: 'https://override/webhook',
			} as NodeJS.ProcessEnv),
		).toBe('https://override/webhook')
	})

	it('can trigger webhook when publish is skipped (webhook flag)', async () => {
		const requests: string[] = []

		vi.stubGlobal('fetch', (async (input: string | URL | Request, _init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString()
			requests.push(url)
			if (url.includes('oidc')) {
				return new Response(JSON.stringify({ value: 'test-token' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			}
			return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
		}) as typeof fetch)

		try {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				const result = await publishPackage({
					cwd: fixture.path,
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
					readPackageJson: readPackageJsonFrom(fixture),
				})

				expect(result.notified).toBe(true)
				expect(requests.some((url) => url.includes('oidc.example.com'))).toBe(true)
				expect(
					requests.some((url) => url.includes('market.pluxel.dev') || url.includes('market.test')),
				).toBe(true)
			})
		} finally {
			vi.unstubAllGlobals()
		}
	})
})
