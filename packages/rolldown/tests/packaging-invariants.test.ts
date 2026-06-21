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
		const offenders: string[] = []

		for (const file of runtimeDynamicFiles) {
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
		const runtimeDynamic = await readJson(`${root}/packages/runtime-dynamic/package.json`)
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
		expect(runtimeDynamic.dependencies).not.toHaveProperty('exsolve')
		expect(runtimeDynamic.dependencies).not.toHaveProperty('pkg-types')
		expect(test.inlinedDependencies).not.toHaveProperty('pathe')
	})
})
