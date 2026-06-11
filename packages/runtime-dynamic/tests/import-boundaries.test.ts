import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolve } from 'pathe'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
const scanRoots = [
	resolve(workspaceRoot, 'packages/runtime-dynamic/src'),
	resolve(workspaceRoot, 'packages/runtime/src/services'),
	resolve(workspaceRoot, 'packages/runtime/src/api/http'),
]

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/
const FORBIDDEN_IMPORT_RE =
	/import\s+(?!type\b)[\s\S]*?\sfrom\s+['"](@pluxel\/runtime\/web(?:\/ui)?)['"]/g

function collectFiles(root: string): string[] {
	const stats = statSync(root, { throwIfNoEntry: false })
	if (!stats) return []
	if (stats.isFile()) return SOURCE_FILE_RE.test(root) ? [root] : []

	const result: string[] = []
	for (const entry of readdirSync(root)) {
		if (entry === 'dist' || entry === 'node_modules') continue
		result.push(...collectFiles(resolve(root, entry)))
	}
	return result
}

describe('runtime web import boundaries', () => {
	it('keeps server and hmr code off the React-heavy web entrypoints', () => {
		const offenders: string[] = []

		for (const root of scanRoots) {
			for (const file of collectFiles(root)) {
				const source = readFileSync(file, 'utf-8')
				if (!FORBIDDEN_IMPORT_RE.test(source)) continue
				offenders.push(file.replace(`${workspaceRoot}/`, ''))
			}
		}

		expect(offenders).toEqual([])
	})
})
