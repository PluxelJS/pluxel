import { describe, expect, it } from 'bun:test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'pathe'
import { publishWorkspaces } from '../src/publish'

const TEST_ROOT = new URL('.', import.meta.url)

async function setupFixture() {
	const base = resolve(TEST_ROOT.pathname, 'fixtures', 'publish')
	const target = await mkdtemp(join(tmpdir(), 'pluxel-cli-publish-'))
	await cp(base, target, { recursive: true })
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

describe('publish task', () => {
	it('publishes only packages with bumped versions', async () => {
		const dir = await setupFixture()
		const published: string[] = []
		try {
			const result = await publishWorkspaces({
				root: dir,
				resolvePublishedVersion: async (name) => (name === 'example-c' ? '2.0.0' : '1.0.0'),
				publisher: async (target) => {
					published.push(`${target.name}@${target.version}`)
				},
				// skip network calls in tests
				notifier: async () => {},
				requireOidc: false,
				log: () => {},
			})

			expect(result.planned.map((t) => t.name)).toEqual(['example-a'])
			expect(published).toEqual(['example-a@1.1.0'])
		} finally {
			await teardownFixture(dir)
		}
	})

	it('sends notifier payload with oidc token on CI', async () => {
		const dir = await setupFixture()
		const savedEnv = snapshotEnv(['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'PLUXEL_OIDC_TOKEN'])
		const notifications: Array<{ names: string[]; token?: string; repo?: string }> = []
		try {
			process.env.GITHUB_ACTIONS = 'true'
			process.env.GITHUB_REPOSITORY = 'acme/example'
			process.env.PLUXEL_OIDC_TOKEN = 'oidc-token'

			const result = await publishWorkspaces({
				root: dir,
				resolvePublishedVersion: async (name) => {
					if (name === 'example-a') return '1.0.0'
					if (name === 'example-c') return '2.0.0'
					return '0.0.0'
				},
				publisher: async () => {},
				notifier: async (targets, context) => {
					notifications.push({
						names: targets.map((t) => t.name),
						token: context.oidcToken,
						repo: context.ciContext?.repo,
					})
				},
				marketBaseUrl: 'https://example.com/market',
				log: () => {},
			})

			expect(result.notified).toBe(true)
			expect(notifications[0]?.names).toEqual(['example-a'])
			expect(notifications[0]?.token).toBe('oidc-token')
			expect(notifications[0]?.repo).toBe('acme/example')
		} finally {
			restoreEnv(savedEnv)
			await teardownFixture(dir)
		}
	})
})

describe('publish notifier', () => {
	it('prefers market RPC client when available', async () => {
		const dir = await setupFixture()
		const savedEnv = snapshotEnv([
			'GITHUB_ACTIONS',
			'GITHUB_REPOSITORY',
			'PLUXEL_OIDC_TOKEN',
			'PLUXEL_MARKET_BASE_URL',
		])
		const captured: Array<{ names: string[]; base?: string; token?: string }> = []
		try {
			process.env.GITHUB_ACTIONS = 'true'
			process.env.GITHUB_REPOSITORY = 'acme/example'
			process.env.PLUXEL_OIDC_TOKEN = 'oidc-token'
			process.env.PLUXEL_MARKET_BASE_URL = 'https://market.example.dev'

			await publishWorkspaces({
				root: dir,
				resolvePublishedVersion: async () => '0.0.0',
				publisher: async () => {},
				notifier: async (targets, context) => {
					captured.push({
						names: targets.map((t) => t.name),
						base: context.marketBaseUrl,
						token: context.oidcToken,
					})
				},
				log: () => {},
			})

			expect(captured.length).toBe(1)
			expect(captured[0]?.names).toEqual(['example-a', 'example-c'])
			expect(captured[0]?.token).toBe('oidc-token')
			expect(captured[0]?.base).toBe('https://market.example.dev')
		} finally {
			restoreEnv(savedEnv)
			await teardownFixture(dir)
		}
	})
})
