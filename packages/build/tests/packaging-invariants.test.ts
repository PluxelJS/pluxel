import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

type PackageJson = {
	name?: string
	private?: boolean
	exports?: unknown
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

function quotedStringPattern(value: string) {
	const escaped = value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return new RegExp(`["'\`]${escaped}["'\`]`)
}

function forbiddenImportPattern(specifier: string) {
	const escaped = specifier.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
	return new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*)["'\`]${escaped}["'\`]`)
}

function collectExportConditions(exportsField: unknown): Set<string> {
	const out = new Set<string>()
	const visit = (value: unknown) => {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return
		for (const [key, child] of Object.entries(value)) {
			if (key.startsWith('@pluxel/')) out.add(key)
			visit(child)
		}
	}
	visit(exportsField)
	return out
}

async function collectSourceFiles(dir: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (current: string) => {
		let entries
		try {
			entries = await readdir(current, { withFileTypes: true, encoding: 'utf8' })
		} catch {
			return
		}
		for (const ent of entries) {
			if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.turbo') continue
			const next = join(current, ent.name)
			if (ent.isDirectory()) {
				await walk(next)
				continue
			}
			if (/\.(?:ts|tsx|mts|cts)$/.test(ent.name)) out.push(next)
		}
	}
	await walk(dir)
	return out.sort()
}

describe('packaging invariants', () => {
	it('only core/runtime/runtime-dynamic/runtime-static/cli/test/ops are publishable', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const workspace = await collectWorkspacePackages(root)
		const publishable = new Set([
			'@pluxel/core',
			'@pluxel/runtime',
			'@pluxel/runtime-dynamic',
			'@pluxel/runtime-static',
			'@pluxel/cli',
			'@pluxel/test',
			'@pluxel/ops',
		])
		const mismatches: string[] = []

		for (const [name, meta] of workspace) {
			const expectedPrivate = !publishable.has(name)
			if (meta.private !== expectedPrivate) {
				mismatches.push(
					expectedPrivate
						? `${name} must be private (${meta.path})`
						: `${name} must not be private (${meta.path})`,
				)
			}
		}

		expect(mismatches).toEqual([])
	})

	it('published packages do not depend on workspace packages at runtime', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const workspace = await collectWorkspacePackages(root)

		const packages = [
			{ name: '@pluxel/core', path: `${root}/packages/core/package.json` },
			{ name: '@pluxel/runtime', path: `${root}/packages/runtime/package.json` },
			{ name: '@pluxel/runtime-dynamic', path: `${root}/packages/runtime-dynamic/package.json` },
			{ name: '@pluxel/runtime-static', path: `${root}/packages/runtime-static/package.json` },
			{ name: '@pluxel/cli', path: `${root}/packages/cli/package.json` },
			{ name: '@pluxel/test', path: `${root}/packages/test/package.json` },
			{ name: '@pluxel/ops', path: `${root}/packages/ops/package.json` },
		] as const

		const allowedWorkspaceDeps = new Map<string, ReadonlySet<string>>([
			['@pluxel/core', new Set()],
			['@pluxel/runtime', new Set(['@pluxel/core', '@pluxel/ops'])],
			['@pluxel/runtime-dynamic', new Set(['@pluxel/core', '@pluxel/runtime'])],
			['@pluxel/runtime-static', new Set(['@pluxel/core', '@pluxel/runtime'])],
			['@pluxel/cli', new Set(['@pluxel/runtime-dynamic', '@pluxel/runtime'])],
			['@pluxel/test', new Set()],
			['@pluxel/ops', new Set()],
		])
		const privateRuntimeDeps: string[] = []
		const disallowedRuntimeDeps: string[] = []

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
					privateRuntimeDeps.push(
						`${pkg.name} must not depend on private workspace package "${dep}" (${ws.path}) at runtime`,
					)
					continue
				}

				if (!allow.has(dep)) {
					disallowedRuntimeDeps.push(
						`${pkg.name} must not depend on workspace package "${dep}" at runtime`,
					)
				}
			}
		}

		expect(privateRuntimeDeps).toEqual([])
		expect(disallowedRuntimeDeps).toEqual([])
	})

	it('uses only real Pluxel export conditions', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const workspace = await collectWorkspacePackages(root)
		const allowed = new Set(['@pluxel/source', '@pluxel/runtime-dynamic'])
		const offenders: string[] = []

		for (const meta of workspace.values()) {
			const json = await readJson(meta.path)
			for (const condition of collectExportConditions(json.exports)) {
				if (!allowed.has(condition)) offenders.push(`${meta.path}: ${condition}`)
			}
		}

		expect(
			offenders,
			'Pluxel export conditions are fixed: internals use @pluxel/source, plugin dev source uses @pluxel/runtime-dynamic',
		).toEqual([])
	})

	it('published packages explicitly bundle private workspace build-time imports', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))

		const packages = [
			{
				name: '@pluxel/core',
				config: `${root}/packages/core/tsdown.config.ts`,
				alwaysBundle: [
					'@pluxel/context',
					'@pluxel/context/*',
					'@pluxel/core-di',
					'@pluxel/core-di/*',
				],
			},
			{
				name: '@pluxel/runtime',
				config: `${root}/packages/runtime/tsdown.config.ts`,
				alwaysBundle: [
					'@pluxel/workspace/fs',
					'@pluxel/workspace/info',
					'valibot-form',
					'valibot-form/*',
				],
			},
			{
				name: '@pluxel/runtime-dynamic',
				config: `${root}/packages/runtime-dynamic/tsdown.config.ts`,
				alwaysBundle: [
					'@pluxel/build',
					'@pluxel/build/*',
					'@pluxel/workspace/fs',
					'@pluxel/workspace/info',
				],
			},
			{
				name: '@pluxel/cli',
				config: `${root}/packages/cli/tsdown.config.ts`,
				alwaysBundle: [
					'@pluxel/build',
					'@pluxel/build/*',
					'@pluxel/workspace/fs',
					'@pluxel/workspace/info',
				],
			},
			{
				name: '@pluxel/test',
				config: `${root}/packages/test/tsdown.config.ts`,
				alwaysBundle: ['@pluxel/build', '@pluxel/build/*', '@pluxel/workspace/oxlint'],
			},
		] as const

		for (const pkg of packages) {
			const config = await readFile(pkg.config, 'utf8')
			expect(
				config,
				`${pkg.name} should list concrete workspace subpaths instead of bundling all workspace helpers`,
			).not.toMatch(quotedStringPattern('@pluxel/workspace/*'))
			for (const specifier of pkg.alwaysBundle) {
				expect(
					config,
					`${pkg.name} must bundle private workspace import "${specifier}" in ${pkg.config}`,
				).toMatch(quotedStringPattern(specifier))
			}
		}
	})

	it('published package internals use explicit workspace subpaths', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const packageDirs = ['cli', 'components', 'runtime-dynamic', 'runtime-static', 'runtime', 'test'] as const
		const forbidden = forbiddenImportPattern('@pluxel/workspace')
		const offenders: string[] = []

		for (const pkgDir of packageDirs) {
			const files = await collectSourceFiles(`${root}/packages/${pkgDir}`)
			for (const file of files) {
				const code = await readFile(file, 'utf8')
				if (forbidden.test(code)) offenders.push(file)
			}
		}

		expect(
			offenders,
			'published package internals should import @pluxel/workspace via explicit subpaths',
		).toEqual([])
	})

	it('core tests use core test host directly instead of the test package facade', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = await collectSourceFiles(`${root}/packages/core`)
		const allowed = new Set([
			`${root}/packages/core/fsm/tests/macro-bake.test.ts`,
			`${root}/packages/core/tests/PluxelOxlintPlugin.test.ts`,
		])
		const forbidden = forbiddenImportPattern('@pluxel/test')
		const offenders: string[] = []

		for (const file of files) {
			if (allowed.has(file)) continue
			const code = await readFile(file, 'utf8')
			if (forbidden.test(code)) offenders.push(file)
		}

		expect(
			offenders,
			'core package internals should import @pluxel/core/test, not @pluxel/test',
		).toEqual([])
	})

	it('workspace vite helpers are consumed through the workspace package subpath', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = [
			...(await collectSourceFiles(`${root}/packages/components`)),
			...(await collectSourceFiles(`${root}/packages/runtime`)),
		]
		const offenders: string[] = []

		for (const file of files) {
			const code = await readFile(file, 'utf8')
			if (code.includes('../workspace/src/vite') || code.includes('../../workspace/src/vite')) {
				offenders.push(file)
			}
		}

		expect(
			offenders,
			'components/runtime should import workspace Vite helpers from @pluxel/workspace/vite',
		).toEqual([])
	})
})
