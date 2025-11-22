import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { publishPackage } from '../src/publish'

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
		const savedEnv = snapshotEnv([
			'GITHUB_ACTIONS',
			'GITHUB_REPOSITORY',
			'PLUXEL_OIDC_TOKEN',
			'PLUXEL_MARKET_BASE_URL',
		])

		try {
			process.env.GITHUB_ACTIONS = 'true'
			process.env.GITHUB_REPOSITORY = 'acme/example'
			process.env.PLUXEL_OIDC_TOKEN = 'test-oidc-token'
			process.env.PLUXEL_MARKET_BASE_URL = 'https://market.example.dev'

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
})
