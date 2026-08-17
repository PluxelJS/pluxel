import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

async function collectSourceFiles(dir: string): Promise<string[]> {
	const out: string[] = []
	const walk = async (current: string) => {
		const entries = await readdir(current, { withFileTypes: true })
		for (const entry of entries) {
			if (entry.name === 'dist' || entry.name === 'node_modules') continue
			const next = join(current, entry.name)
			if (entry.isDirectory()) {
				await walk(next)
				continue
			}
			if (/\.(?:ts|tsx)$/.test(entry.name)) out.push(next)
		}
	}
	await walk(dir)
	return out.sort()
}

describe('CLI package boundaries', () => {
	it('keeps the scoped initializer as a thin same-version CLI wrapper', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const cliPkg = JSON.parse(await readFile(`${root}/packages/cli/package.json`, 'utf8')) as {
			version: string
		}
		const createPkg = JSON.parse(
			await readFile(`${root}/packages/create/package.json`, 'utf8'),
		) as {
			version: string
			dependencies?: Record<string, string>
			bin?: Record<string, string>
		}
		const createBin = await readFile(`${root}/packages/create/bin/create.mjs`, 'utf8')

		expect(createPkg.version).toBe(cliPkg.version)
		expect(createPkg.dependencies?.['@pluxel/cli']).toBe(`workspace:${cliPkg.version}`)
		expect(createPkg.bin).toEqual({ 'create-pluxel': 'bin/create.mjs' })
		expect(createBin).toContain("Symbol.for('pluxel.cli.direct')")
		expect(createBin).toContain("'new'")
		expect(createBin).not.toContain('../templates')
	})

	it('keeps optional owner value imports behind the official capability loader', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const files = await collectSourceFiles(`${root}/packages/cli/src`)
		const offenders: string[] = []
		const ownerStaticValueImport =
			/^\s*import\s+(?!type\b).*?\s+from\s+['"]@pluxel\/(?:rolldown|runtime-dynamic|market)(?:\/[^'"]*)?['"]/m
		const ownerDynamicImport =
			/import\s*\(\s*['"]@pluxel\/(?:rolldown|runtime-dynamic|market)(?:\/[^'"]*)?['"]\s*\)/g

		for (const file of files) {
			if (file.endsWith('capability-loader.ts')) continue
			const code = await readFile(file, 'utf8')
			const hasRuntimeDynamicImport = [...code.matchAll(ownerDynamicImport)].some((match) => {
				const lineStart = code.lastIndexOf('\n', match.index ?? 0) + 1
				const prefix = code.slice(lineStart, match.index)
				return !/\btype\b/.test(prefix)
			})
			if (ownerStaticValueImport.test(code) || hasRuntimeDynamicImport) offenders.push(file)
		}

		expect(offenders).toEqual([])
	})

	it('keeps optional owners external in the CLI tsdown config', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const code = await readFile(`${root}/packages/cli/tsdown.config.ts`, 'utf8')

		for (const owner of ['@pluxel/market', '@pluxel/rolldown', '@pluxel/runtime-dynamic']) {
			expect(code).toContain(`'${owner}'`)
			expect(code).toContain(`'${owner}/*'`)
			expect(code).not.toMatch(new RegExp(`alwaysBundle:\\s*\\[[^\\]]*['"]${owner}`))
		}
	})
})
