import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDistributionManifest } from '../src/distribution'
import { writeStaticConfigEnvironmentExample } from '../src/cli/static-config-environment-output'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('static config environment example output', () => {
	it('writes exact bytes before finalization and enters the distribution inventory', async () => {
		const root = await createRoot()
		const content = '# generated\n# APP_VALUE=\n'
		await expect(
			writeStaticConfigEnvironmentExample({
				outDir: root,
				bundle: {},
				content,
				ownedExisting: false,
			}),
		).resolves.toBe(true)
		await expect(readFile(join(root, '.env.example'), 'utf8')).resolves.toBe(content)

		await writeDeploymentFixture(root)
		const manifest = await createDistributionManifest(root)
		expect(manifest.entries.map((entry) => entry.path)).toContain('.env.example')
	})

	it('rejects an existing filesystem asset without overwriting it', async () => {
		const root = await createRoot()
		await writeFile(join(root, '.env.example'), 'user-owned\n')
		await expect(
			writeStaticConfigEnvironmentExample({
				outDir: root,
				bundle: {},
				content: '# generated\n',
				ownedExisting: false,
			}),
		).rejects.toThrow('generated asset collision at reserved path .env.example')
		await expect(readFile(join(root, '.env.example'), 'utf8')).resolves.toBe('user-owned\n')
	})

	it('rejects a bundle asset collision even before the path exists', async () => {
		const root = await createRoot()
		await expect(
			writeStaticConfigEnvironmentExample({
				outDir: root,
				bundle: { collision: { fileName: '.env.example' } },
				content: '# generated\n',
				ownedExisting: false,
			}),
		).rejects.toThrow('generated asset collision at reserved path .env.example')
	})

	it('allows the same plugin instance to replace and withdraw its watch output', async () => {
		const root = await createRoot()
		const owned = await writeStaticConfigEnvironmentExample({
			outDir: root,
			bundle: {},
			content: '# first\n',
			ownedExisting: false,
		})
		await expect(
			writeStaticConfigEnvironmentExample({
				outDir: root,
				bundle: {},
				content: '# second\n',
				ownedExisting: owned,
			}),
		).resolves.toBe(true)
		await expect(readFile(join(root, '.env.example'), 'utf8')).resolves.toBe('# second\n')
		await expect(
			writeStaticConfigEnvironmentExample({
				outDir: root,
				bundle: {},
				content: undefined,
				ownedExisting: true,
			}),
		).resolves.toBe(false)
		await expect(readFile(join(root, '.env.example'), 'utf8')).rejects.toMatchObject({
			code: 'ENOENT',
		})
	})
})

async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-config-environment-output-'))
	roots.push(root)
	return root
}

async function writeDeploymentFixture(root: string): Promise<void> {
	await writeFile(join(root, 'app.mjs'), 'export const app = true\n')
	await writeFile(
		join(root, 'pluxel-deployment.json'),
		`${JSON.stringify({
			version: 1,
			kind: 'pluxel-static-application',
			application: { name: 'fixture', catalogHash: 'a'.repeat(64) },
			server: { entry: 'app.mjs', runtimeClosure: 'bundled', target: 'node' },
			capabilities: {
				nodeModules: { root: 'artifacts/node', artifacts: [] },
				workbench: { included: false, publicRoot: null, artifacts: [] },
			},
			residualDependencies: { mode: 'bundle', packages: [] },
		})}\n`,
	)
}
