import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { offlineMonaco } from '../scripts/monaco-vite'

describe('offline Monaco module transforms', () => {
	for (const [specifier, localLoader] of [
		['modern-monaco/core', 'import("./editor-core.mjs")'],
		[
			'modern-monaco/editor-core',
			'new Worker(new URL("./editor-worker-main.mjs", import.meta.url)',
		],
		['modern-monaco/lsp/typescript/setup', 'new Worker(new URL("./worker.mjs", import.meta.url)'],
	]) {
		it(`keeps ${specifier} local with Vite development query suffixes`, async () => {
			const path = fileURLToPath(import.meta.resolve(specifier!))
			const source = await readFile(path, 'utf8')
			const hook = offlineMonaco().transform!
			const transform = typeof hook === 'function' ? hook : hook.handler
			for (const id of [
				path,
				path + '?v=dependency-hash',
				path.replaceAll('/', '\\') + '?worker_file&type=module',
			]) {
				const output = await transform.call({} as never, source, id)
				expect(output).toContain(localLoader)
			}
		})
	}
})
