import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFixture, type TestFixture } from '@pluxel/test/fixtures'
import type { MarketReceipt } from '../src/publish/market-notification'
import type { ExecResult } from '../src/utils/exec'

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

async function mockNpm(
	result: ExecResult | ((command: string, args: string[]) => Promise<ExecResult>),
	registryConfig: Record<string, string> = {},
) {
	const config: Record<string, string> = {
		registry: 'https://registry.npmjs.org/',
		scope: '',
		access: 'null',
		...registryConfig,
	}
	const rc = await getRunCommand()
	rc.mockImplementation(async (command, args) => {
		if (args[0] === 'config') {
			const keys = args.slice(2).filter((key) => !key.startsWith('--'))
			const lines = keys.map(
				(key) => `${keys.length > 1 ? `${key}=` : ''}${config[key] ?? 'undefined'}`,
			)
			return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
		}
		return typeof result === 'function' ? result(command, args) : result
	})
	return rc
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

beforeEach(async () => {
	vi.clearAllMocks()
	await mockNpm({ code: 0, stdout: '', stderr: '' })
})

afterEach(() => {
	vi.restoreAllMocks()
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
			const rc = await mockNpm(async (_command, args) => {
				if (args[0] === 'view')
					return { code: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: '' }
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
			expect(rc).toHaveBeenCalledTimes(3)
			expect(rc.mock.calls[1]).toEqual([
				'npm',
				[
					'view',
					'example-pkg@1.1.0',
					'version',
					'--json',
					'--registry=https://registry.npmjs.org',
					'--scope=',
				],
				{ cwd: fixture.path, env: cleanCiEnv(process.env) },
			])
		})
	})

	it('skips publishing when version already exists', async () => {
		await withPackageFixture('example-pkg', '1.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const rc = await mockNpm({ code: 0, stdout: JSON.stringify('1.0.0'), stderr: '' })

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
			expect(rc).toHaveBeenCalledTimes(2)
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

	it('stops before publishing when the exact-version query fails', async () => {
		await withPackageFixture('example-pkg', '1.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const rc = await mockNpm({ code: 1, stdout: '', stderr: 'E401 Authentication required' })
			await expect(
				publishPackage({
					cwd: fixture.path,
					env: cleanCiEnv(),
					readPackageJson: readPackageJsonFrom(fixture),
				}),
			).rejects.toThrow('npm view example-pkg@1.0.0 failed')
			expect(rc).toHaveBeenCalledTimes(2)
		})
	})

	it('pins scoped version lookup to the same publication source', async () => {
		await withPackageFixture('@acme/plugin', '1.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const registry = 'http://127.0.0.1:7677/npm'
			const rc = await mockNpm(
				{ code: 0, stdout: '"1.0.0"', stderr: '' },
				{
					'@acme:registry': registry,
				},
			)
			const result = await publishPackage({
				cwd: fixture.path,
				env: cleanCiEnv(),
				readPackageJson: readPackageJsonFrom(fixture),
			})
			expect(result).toMatchObject({ registry, alreadyPublished: true, published: false })
			expect(rc).toHaveBeenCalledWith(
				'npm',
				[
					'view',
					'@acme/plugin@1.0.0',
					'version',
					'--json',
					`--registry=${registry}`,
					'--scope=',
					`--@acme:registry=${registry}`,
				],
				{ cwd: fixture.path, env: cleanCiEnv() },
			)
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
})

const pendingReceipt: MarketReceipt = {
	id: 'test-receipt',
	registry: 'https://registry.npmjs.org',
	name: 'example-pkg',
	version: '6.0.0',
	status: 'pending',
	attempts: 0,
	createdAt: 1,
	updatedAt: 1,
	nextAttemptAt: 1,
	code: null,
}

type MarketRequest = { method: string; path: string; body: unknown; authorization?: string }

async function withMarket<T>(
	status: number,
	body: unknown,
	run: (url: string, requests: MarketRequest[]) => Promise<T>,
) {
	const requests: MarketRequest[] = []
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = []
		for await (const chunk of request) chunks.push(Buffer.from(chunk))
		requests.push({
			method: request.method!,
			path: request.url!,
			body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
			...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
		})
		response.writeHead(status, { 'Content-Type': 'application/json' })
		const output: unknown = typeof body === 'function' ? body(requests.at(-1)!.body) : body
		response.end(JSON.stringify(output))
	})
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(0, '127.0.0.1', resolve)
		})
		const address = server.address()
		if (!address || typeof address === 'string') throw new Error('Expected TCP address')
		return await run(`http://127.0.0.1:${address.port}`, requests)
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()))
			server.closeAllConnections()
		})
	}
}

describe('publish market notification', () => {
	it('sends a bearer token only to the explicitly selected market without logging it', async () => {
		const logs: string[] = []
		const registry = 'http://127.0.0.1:7677/npm'
		await withMarket(202, { ...pendingReceipt, registry }, async (marketUrl, requests) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				await mockNpm({ code: 0, stdout: '', stderr: '' }, { registry })
				await publishPackage({
					cwd: fixture.path,
					skipVersionCheck: true,
					webhook: true,
					marketUrl,
					env: { ...cleanCiEnv(), PLUXEL_MARKET_TOKEN: 'private-notification-token' },
					log: (...args) => logs.push(args.join(' ')),
					readPackageJson: readPackageJsonFrom(fixture),
				})
				expect(requests[0].authorization).toBe('Bearer private-notification-token')
				expect(logs.join('\n')).not.toContain('private-notification-token')
			})
		})
	})

	it('rejects implicit token use before publishing to public npm or the default market', async () => {
		await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const rc = await getRunCommand()
			const request = vi.spyOn(globalThis, 'fetch')
			await expect(
				publishPackage({
					cwd: fixture.path,
					skipVersionCheck: true,
					env: {
						GITHUB_ACTIONS: 'true',
						GITHUB_REPOSITORY: 'acme/example',
						PLUXEL_MARKET_TOKEN: 'private-token',
					},
					readPackageJson: readPackageJsonFrom(fixture),
				}),
			).rejects.toThrow('PLUXEL_MARKET_TOKEN requires an explicit --market-url')
			expect(rc.mock.calls.every(([, args]) => args[0] === 'config')).toBe(true)
			expect(request).not.toHaveBeenCalled()
		})
	})

	it.each(['', 'token with whitespace', 'token\r\ninjected'])(
		'rejects an invalid token before publishing (%j)',
		async (token) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				const rc = await getRunCommand()
				const request = vi.spyOn(globalThis, 'fetch')
				await expect(
					publishPackage({
						cwd: fixture.path,
						skipVersionCheck: true,
						webhook: true,
						marketUrl: 'https://market.example',
						env: { ...cleanCiEnv(), PLUXEL_MARKET_TOKEN: token },
						readPackageJson: readPackageJsonFrom(fixture),
					}),
				).rejects.toThrow('PLUXEL_MARKET_TOKEN must be a nonempty bearer token without whitespace')
				expect(rc.mock.calls.every(([, args]) => args[0] === 'config')).toBe(true)
				expect(request).not.toHaveBeenCalled()
			})
		},
	)

	it('keeps the same package coordinates distinct across two real registry identities', async () => {
		const registries = ['https://registry.npmjs.org', 'http://127.0.0.1:7677/npm']
		const receipts = registries.map((registry, index) => ({
			...pendingReceipt,
			registry,
			id: `receipt-${index}`,
		}))
		await withMarket(
			202,
			(input: { registry: string }) =>
				receipts.find((receipt) => receipt.registry === input.registry),
			async (marketUrl, requests) => {
				await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
					const { publishPackage } = await getPublish()
					for (const [index, registry] of registries.entries()) {
						const rc = await mockNpm(
							{ code: 0, stdout: '"6.0.0"', stderr: '' },
							{ registry: `${registry}/` },
						)
						const result = await publishPackage({
							cwd: fixture.path,
							webhook: true,
							marketUrl,
							env: cleanCiEnv(),
							readPackageJson: readPackageJsonFrom(fixture),
						})
						expect(result.registry).toBe(registry)
						expect(result.notification?.receipt).toEqual(receipts[index])
						expect(rc).toHaveBeenCalledWith(
							'npm',
							[
								'view',
								'example-pkg@6.0.0',
								'version',
								'--json',
								`--registry=${registry}`,
								'--scope=',
							],
							{ cwd: fixture.path, env: cleanCiEnv() },
						)
					}
				})
				expect(requests.map((request) => request.body)).toEqual(
					registries.map((registry) => ({ registry, name: 'example-pkg', version: '6.0.0' })),
				)
			},
		)
	})

	it('rejects a receipt with the right package but another registry', async () => {
		await withMarket(
			202,
			{ ...pendingReceipt, registry: 'https://other.example/npm' },
			async (marketUrl) => {
				await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
					const { publishPackage } = await getPublish()
					await expect(
						publishPackage({
							cwd: fixture.path,
							skipVersionCheck: true,
							webhook: true,
							marketUrl,
							env: cleanCiEnv(),
							readPackageJson: readPackageJsonFrom(fixture),
						}),
					).rejects.toThrow('invalid notification receipt')
				})
			},
		)
	})

	it('skips implicit CI notification for private registries', async () => {
		await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			await mockNpm({ code: 0, stdout: '', stderr: '' }, { registry: 'http://127.0.0.1:7677/npm/' })
			const request = vi.spyOn(globalThis, 'fetch')
			const result = await publishPackage({
				cwd: fixture.path,
				skipVersionCheck: true,
				env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/example' },
				readPackageJson: readPackageJsonFrom(fixture),
			})
			expect(result).toMatchObject({
				published: true,
				notified: false,
				registry: 'http://127.0.0.1:7677/npm',
			})
			expect(request).not.toHaveBeenCalled()
		})
	})

	it.each([
		{ registry: 'http://127.0.0.1:7677/npm/', access: 'public' },
		{ registry: 'https://registry.npmjs.org/', access: 'restricted' },
	])(
		'requires explicit market destination before notifying private source/access %j',
		async ({ registry, access }) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				const rc = await mockNpm({ code: 0, stdout: '', stderr: '' }, { registry })
				const request = vi.spyOn(globalThis, 'fetch')
				await expect(
					publishPackage({
						cwd: fixture.path,
						skipVersionCheck: true,
						access,
						webhook: true,
						env: cleanCiEnv(),
						readPackageJson: readPackageJsonFrom(fixture),
					}),
				).rejects.toThrow('--webhook requires an explicit --market-url')
				expect(rc.mock.calls.every(([, args]) => args[0] === 'config')).toBe(true)
				expect(request).not.toHaveBeenCalled()
			})
		},
	)

	it.each([
		'ftp://market.example',
		'https://user:secret@market.example',
		'https://market.example?token=secret',
		'https://market.example/private',
	])('rejects invalid market origin %s before publishing', async (marketUrl) => {
		await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const rc = await getRunCommand()
			const request = vi.spyOn(globalThis, 'fetch')
			await expect(
				publishPackage({
					cwd: fixture.path,
					skipVersionCheck: true,
					webhook: true,
					marketUrl,
					env: cleanCiEnv(),
					readPackageJson: readPackageJsonFrom(fixture),
				}),
			).rejects.toThrow('HTTP(S) origin without credentials, path, query or fragment')
			expect(rc.mock.calls.every(([, args]) => args[0] === 'config')).toBe(true)
			expect(request).not.toHaveBeenCalled()
		})
	})

	it('retains the HTTP 202 receipt and query URL without reporting indexing complete', async () => {
		const logs: string[] = []
		await withMarket(202, pendingReceipt, async (marketUrl, requests) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				await mockNpm({ code: 0, stdout: '', stderr: '' })
				const result = await publishPackage({
					cwd: fixture.path,
					skipVersionCheck: true,
					marketUrl,
					webhook: true,
					env: cleanCiEnv(),
					log: (...args) => logs.push(args.join(' ')),
					readPackageJson: readPackageJsonFrom(fixture),
				})
				expect(result).toMatchObject({
					published: true,
					notified: true,
					notification: {
						receipt: pendingReceipt,
						url: `${marketUrl}/v1/notifications/test-receipt`,
					},
				})
				expect(requests).toEqual([
					{
						method: 'POST',
						path: '/v1/notifications',
						body: { registry: 'https://registry.npmjs.org', name: 'example-pkg', version: '6.0.0' },
					},
				])
				expect(logs.some((line) => line.includes('indexing is not complete'))).toBe(true)
			})
		})
	})

	it('notifies an existing exact release and preserves its failed duplicate receipt', async () => {
		const receipt = { ...pendingReceipt, status: 'failed', code: 'provenance-runtime-unsupported' }
		await withMarket(200, receipt, async (marketUrl, requests) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				const rc = await mockNpm({ code: 0, stdout: '"6.0.0"', stderr: '' })
				const result = await publishPackage({
					cwd: fixture.path,
					marketUrl,
					webhook: true,
					env: cleanCiEnv(),
					readPackageJson: readPackageJsonFrom(fixture),
				})
				expect(result).toMatchObject({
					published: false,
					alreadyPublished: true,
					notified: true,
					notification: { receipt },
				})
				expect(rc).toHaveBeenCalledTimes(2)
				expect(rc).toHaveBeenCalledWith(
					'npm',
					[
						'view',
						'example-pkg@6.0.0',
						'version',
						'--json',
						'--registry=https://registry.npmjs.org',
						'--scope=',
					],
					{ cwd: fixture.path, env: cleanCiEnv() },
				)
				expect(requests).toHaveLength(1)
			})
		})
	})

	it('keeps dry-run with --webhook free of publish and notification writes', async () => {
		await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			const rc = await getRunCommand()
			const request = vi.spyOn(globalThis, 'fetch')
			const result = await publishPackage({
				cwd: fixture.path,
				dryRun: true,
				skipVersionCheck: true,
				webhook: true,
				env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/example' },
				readPackageJson: readPackageJsonFrom(fixture),
			})
			expect(result).toMatchObject({ published: false, notified: false })
			expect(rc.mock.calls.every(([, args]) => args[0] === 'config')).toBe(true)
			expect(request).not.toHaveBeenCalled()
		})
	})

	it('does not notify when npm publish fails', async () => {
		await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
			const { publishPackage } = await getPublish()
			await mockNpm({ code: 1, stdout: '', stderr: 'publish refused' })
			const request = vi.spyOn(globalThis, 'fetch')
			await expect(
				publishPackage({
					cwd: fixture.path,
					skipVersionCheck: true,
					webhook: true,
					readPackageJson: readPackageJsonFrom(fixture),
				}),
			).rejects.toThrow('npm publish failed')
			expect(request).not.toHaveBeenCalled()
		})
	})

	it('retains npm success when an explicitly requested notification is rejected', async () => {
		await withMarket(429, { code: 'notification-capacity' }, async (marketUrl) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				await mockNpm({ code: 0, stdout: '', stderr: '' })
				await expect(
					publishPackage({
						cwd: fixture.path,
						skipVersionCheck: true,
						webhook: true,
						marketUrl,
						env: cleanCiEnv(),
						readPackageJson: readPackageJsonFrom(fixture),
					}),
				).rejects.toThrow(
					'npm publish succeeded, but market notification failed: Market rejected the notification (HTTP 429, notification-capacity)',
				)
			})
		})
	})

	it('reports a CI notification failure as a warning after npm success', async () => {
		const logs: string[] = []
		await withMarket(503, { code: 'unavailable' }, async (marketUrl) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				await mockNpm({ code: 0, stdout: '', stderr: '' })
				const result = await publishPackage({
					cwd: fixture.path,
					skipVersionCheck: true,
					marketUrl,
					env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/example' },
					log: (...args) => logs.push(args.join(' ')),
					readPackageJson: readPackageJsonFrom(fixture),
				})
				expect(result).toMatchObject({ published: true, notified: false })
				expect(
					logs.some((line) =>
						line.includes('npm publish succeeded, but market notification failed'),
					),
				).toBe(true)
			})
		})
	})

	it('rejects a receipt for a different release', async () => {
		await withMarket(202, { ...pendingReceipt, version: '1.0.0' }, async (marketUrl) => {
			await withPackageFixture('example-pkg', '6.0.0', undefined, async (fixture) => {
				const { publishPackage } = await getPublish()
				await mockNpm({ code: 0, stdout: '', stderr: '' })
				await expect(
					publishPackage({
						cwd: fixture.path,
						skipVersionCheck: true,
						webhook: true,
						marketUrl,
						env: cleanCiEnv(),
						readPackageJson: readPackageJsonFrom(fixture),
					}),
				).rejects.toThrow('invalid notification receipt')
			})
		})
	})
})
