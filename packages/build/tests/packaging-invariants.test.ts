import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

type PackageJson = {
	name?: string
	private?: boolean
	dependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
}

async function readJson(path: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path, 'utf8')) as PackageJson
}

async function collectWorkspacePackages(root: string) {
	const out = new Map<string, { private: boolean; path: string }>()
	const packagesDir = join(root, 'packages')

	const walk = async (dir: string, depth: number) => {
		if (depth <= 0) return
		let entries
		try {
			entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' })
		} catch {
			return
		}

		for (const ent of entries) {
			if (!ent.isDirectory()) continue
			if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.turbo') continue
			const next = join(dir, ent.name)
			const pkgJsonPath = join(next, 'package.json')
			try {
				const json = await readJson(pkgJsonPath)
				const name = typeof json.name === 'string' ? json.name : ''
				if (name) {
					out.set(name, { private: Boolean(json.private), path: pkgJsonPath })
					continue
				}
			} catch {
				// not a package dir
			}
			await walk(next, depth - 1)
		}
	}

	await walk(packagesDir, 3)
	return out
}

describe('packaging invariants', () => {
	it('only core/runtime/hmr/cli/test are publishable', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const workspace = await collectWorkspacePackages(root)
		const publishable = new Set([
			'@pluxel/core',
			'@pluxel/runtime',
			'@pluxel/hmr',
			'@pluxel/cli',
			'@pluxel/test',
		])

		for (const [name, meta] of workspace) {
			if (publishable.has(name)) {
				expect(meta.private, `${name} must not be private (${meta.path})`).toBe(false)
				continue
			}
			expect(meta.private, `${name} must be private (${meta.path})`).toBe(true)
		}
	})

	it('published packages do not depend on workspace packages at runtime', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const workspace = await collectWorkspacePackages(root)

		const packages = [
			{ name: '@pluxel/core', path: `${root}/packages/core/package.json` },
			{ name: '@pluxel/runtime', path: `${root}/packages/runtime/package.json` },
			{ name: '@pluxel/hmr', path: `${root}/packages/hmr/package.json` },
			{ name: '@pluxel/cli', path: `${root}/packages/cli/package.json` },
			{ name: '@pluxel/test', path: `${root}/packages/test/package.json` },
		] as const

		const allowedWorkspaceDeps = new Map<string, ReadonlySet<string>>([
			['@pluxel/core', new Set()],
			['@pluxel/runtime', new Set(['@pluxel/core'])],
			['@pluxel/hmr', new Set(['@pluxel/core', '@pluxel/runtime'])],
			['@pluxel/cli', new Set(['@pluxel/hmr'])],
			['@pluxel/test', new Set()],
		])

		for (const pkg of packages) {
			const json = await readJson(pkg.path)
			expect(json.name).toBe(pkg.name)

			const deps = [
				...Object.keys(json.dependencies ?? {}),
				...Object.keys(json.optionalDependencies ?? {}),
			]
			const allow = allowedWorkspaceDeps.get(pkg.name) ?? new Set()

			for (const dep of deps) {
				const ws = workspace.get(dep)
				if (!ws) continue

				if (ws.private) {
					expect(
						false,
						`${pkg.name} must not depend on private workspace package "${dep}" (${ws.path}) at runtime`,
					).toBe(true)
					continue
				}

				expect(
					allow.has(dep),
					`${pkg.name} must not depend on workspace package "${dep}" at runtime`,
				).toBe(true)
			}
		}
	})
})
