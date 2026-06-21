import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

type PackageJson = {
	exports?: unknown
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	inlinedDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	private?: boolean
}

async function readJson(path: string): Promise<PackageJson> {
	return JSON.parse(await readFile(path, 'utf8')) as PackageJson
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

describe('toolchain package boundaries', () => {
	it('keeps Vite toolchain helpers out of runtime public exports', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtime = await readJson(`${root}/packages/runtime/package.json`)
		const rolldown = await readJson(`${root}/packages/rolldown/package.json`)

		expect(runtime.exports).not.toHaveProperty('./vite')
		expect(rolldown.exports).toHaveProperty('./vite')
		expect(rolldown.exports).toHaveProperty('./vite/environment')
		expect(rolldown.exports).toHaveProperty('./resolver/oxc')
	})

	it('keeps plugin UI Module Federation build logic in the rolldown package', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDynamicFiles = await collectSourceFiles(`${root}/packages/runtime-dynamic/src`)
		const runtimeDevFiles = await collectSourceFiles(`${root}/packages/runtime-dev/src`)
		const offenders: string[] = []

		for (const file of [...runtimeDynamicFiles, ...runtimeDevFiles]) {
			const code = await readFile(file, 'utf8')
			if (code.includes('@module-federation/vite')) offenders.push(file)
		}

		expect(
			offenders,
			'runtime-dynamic should call @pluxel/rolldown/vite/plugin-ui instead of owning MF build logic',
		).toEqual([])
	})

	it('keeps Rolldown plugin utility dependencies inside the rolldown package', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeDynamic = await readJson(`${root}/packages/runtime-dynamic/package.json`)

		expect(runtimeDynamic.dependencies).not.toHaveProperty('@rolldown/pluginutils')
	})

	it('keeps toolchain implementation helpers out of published runtime dependencies', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const rolldown = await readJson(`${root}/packages/rolldown/package.json`)
		const runtime = await readJson(`${root}/packages/runtime/package.json`)
		const runtimeDev = await readJson(`${root}/packages/runtime-dev/package.json`)
		const runtimeDynamic = await readJson(`${root}/packages/runtime-dynamic/package.json`)
		const runtimeStatic = await readJson(`${root}/packages/runtime-static/package.json`)
		const cli = await readJson(`${root}/packages/cli/package.json`)
		const test = await readJson(`${root}/packages/test/package.json`)

		expect(rolldown.dependencies).toEqual({
			'@inlang/paraglide-js': '^2.15.1',
			'@module-federation/vite': '1.16.6',
			'@pluxel/core': 'workspace:*',
			'oxc-parser': '^0.115.0',
			'oxc-resolver': '^11.21.3',
		})
		expect(rolldown.peerDependencies).toMatchObject({
			rolldown: '1.0.0-rc.5',
			tsdown: '*',
			vite: '>=8.0.0-beta.18 <9',
		})
		for (const name of ['@rolldown/pluginutils', 'fdir', 'pathe']) {
			expect(rolldown.devDependencies).toHaveProperty(name)
			expect(rolldown.dependencies).not.toHaveProperty(name)
		}
		expect(rolldown.devDependencies).not.toHaveProperty('pkg-types')
		expect(rolldown.inlinedDependencies).not.toHaveProperty('exsolve')
		expect(rolldown.inlinedDependencies).not.toHaveProperty('pkg-types')
		expect(runtime.dependencies).not.toHaveProperty('exsolve')
		expect(runtime.dependencies).not.toHaveProperty('pkg-types')
		expect(runtime.dependencies).toHaveProperty('oxc-resolver')
		expect(runtime.dependencies).not.toHaveProperty('@pluxel/runtime-dynamic')
		expect(runtime.dependencies).not.toHaveProperty('@pluxel/runtime-dev')
		expect(runtimeDev.private).toBe(true)
		expect(runtimeDev.dependencies).toHaveProperty('@pluxel/rolldown')
		expect(runtimeDev.dependencies).not.toHaveProperty('oxc-parser')
		expect(runtimeDev.dependencies).not.toHaveProperty('oxc-resolver')
		expect(runtimeDynamic.dependencies).not.toHaveProperty('exsolve')
		expect(runtimeDynamic.dependencies).not.toHaveProperty('pkg-types')
		expect(runtimeDynamic.dependencies).toHaveProperty('@pluxel/rolldown')
		expect(runtimeDynamic.dependencies).not.toHaveProperty('@pluxel/runtime-dev')
		expect(runtimeDynamic.devDependencies).toHaveProperty('@pluxel/runtime-dev')
		expect(runtimeStatic.dependencies).toHaveProperty('@pluxel/rolldown')
		expect(runtimeStatic.dependencies).not.toHaveProperty('@pluxel/runtime-dev')
		expect(runtimeStatic.devDependencies).toHaveProperty('@pluxel/runtime-dev')
		expect(cli.dependencies).toHaveProperty('@pluxel/market')
		expect(cli.dependencies).toHaveProperty('@pluxel/rolldown')
		expect(cli.dependencies).not.toHaveProperty('oxc-parser')
		expect(cli.dependencies).not.toHaveProperty('oxc-resolver')
		expect(test.dependencies).toHaveProperty('@pluxel/rolldown')
		expect(test.dependencies).not.toHaveProperty('oxc-parser')
		expect(test.dependencies).not.toHaveProperty('pathe')
		expect(test.inlinedDependencies).not.toHaveProperty('pathe')
	})

	it('keeps published consumers from vendoring complex rolldown toolchain entries', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const configs = [
			`${root}/packages/cli/tsdown.config.ts`,
			`${root}/packages/runtime-dev/tsdown.config.ts`,
			`${root}/packages/runtime-dynamic/tsdown.config.ts`,
			`${root}/packages/runtime-static/tsdown.config.ts`,
			`${root}/packages/test/tsdown.config.ts`,
		]

		for (const configPath of configs) {
			const code = await readFile(configPath, 'utf8')
			expect(code).not.toMatch(/alwaysBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
			expect(code).not.toContain('../rolldown/src/rolldown')
			expect(code).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		}
	})

	it('keeps the CLI from importing complex sibling package source directly', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const cliFiles = await collectSourceFiles(`${root}/packages/cli/src`)
		const offenders: string[] = []

		for (const file of cliFiles) {
			const code = await readFile(file, 'utf8')
			if (code.includes('../runtime/src/') || code.includes('../runtime-dynamic/src/')) offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps runtime hmr packaging boundaries explicit', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const runtimeConfig = await readFile(`${root}/packages/runtime/tsdown.config.ts`, 'utf8')
		const runtimeDevConfig = await readFile(`${root}/packages/runtime-dev/tsdown.config.ts`, 'utf8')
		const runtimeDynamicConfig = await readFile(
			`${root}/packages/runtime-dynamic/tsdown.config.ts`,
			'utf8',
		)
		const runtimeStaticConfig = await readFile(
			`${root}/packages/runtime-static/tsdown.config.ts`,
			'utf8',
		)
		const runtimeStaticVite = await readFile(`${root}/packages/runtime-static/src/vite.ts`, 'utf8')

		expect(runtimeConfig).toContain('onlyBundle: []')
		expect(runtimeConfig).toContain('../rolldown/src/workspace/fs-entry.ts')
		expect(runtimeConfig).toContain('../rolldown/src/workspace/info-entry.ts')
		expect(runtimeConfig).not.toContain('../rolldown/src/rolldown')
		expect(runtimeConfig).not.toContain('@pluxel/rolldown/vite')
		expect(runtimeDevConfig).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		expect(runtimeDevConfig).not.toContain('../rolldown/src/')
		expect(runtimeDynamicConfig).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		expect(runtimeDynamicConfig).not.toContain('../rolldown/src/')
		expect(runtimeDynamicConfig).toContain("alwaysBundle: ['@pluxel/runtime-dev'")
		expect(runtimeDynamicConfig).toContain('../runtime-dev/src/index.ts')
		expect(runtimeStaticConfig).toMatch(/neverBundle:\s*\[[^\]]*['"]@pluxel\/rolldown/)
		expect(runtimeStaticConfig).toContain("alwaysBundle: ['@pluxel/runtime-dev'")
		expect(runtimeStaticConfig).toContain('../runtime-dev/src/index.ts')
		expect(runtimeStaticVite).toContain('@pluxel/rolldown/plugins')
		expect(runtimeStaticVite).toContain('@pluxel/rolldown/vite')
		expect(runtimeStaticVite).toContain('configSourcePlugin')
		expect(runtimeStaticVite).toContain('runtimeUiBridgePlugin')
	})

	it('keeps native toolchain packages external to generated bundles', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const packageNames = [
			'cli',
			'rolldown',
			'runtime',
			'runtime-dev',
			'runtime-dynamic',
			'runtime-static',
			'test',
		]
		const offenders: string[] = []
		const nativeToolchainPackage =
			/^(?:oxc-(?:parser|resolver)|@oxc-(?:parser|resolver)\/binding-|rolldown|@rolldown\/binding-|oxlint|@oxlint\/binding-|oxfmt|@oxfmt\/binding-)$/

		for (const packageName of packageNames) {
			const pkg = await readJson(`${root}/packages/${packageName}/package.json`)
			for (const dep of Object.keys(pkg.inlinedDependencies ?? {})) {
				if (nativeToolchainPackage.test(dep)) offenders.push(`${packageName}:${dep}`)
			}
		}

		expect(offenders).toEqual([])
	})
})
