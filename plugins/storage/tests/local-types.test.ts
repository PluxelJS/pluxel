import { resolve } from 'node:path'
import { API, DiagnosticCategory } from 'typescript/unstable/sync'
import { expect, it } from 'vitest'

it.each([false, true])(
	'preserves the global stream contract with Node, DOM and Bun declarations (strictNullChecks=%s)',
	(strictNullChecks) => {
		const root = resolve(import.meta.dirname, '..')
		const source = resolve(root, 'src/local.ts')
		const entry = resolve(root, '.local-stream-environment.ts')
		const config = resolve(root, '.tsconfig-local-stream-environment.json')
		const configuration = JSON.stringify({
			extends: resolve(root, 'tsconfig.json'),
			files: [entry],
			include: [],
			compilerOptions: {
				noEmit: true,
				types: ['node'],
				lib: ['ES2024', 'DOM', 'DOM.Iterable'],
				strictNullChecks,
				customConditions: ['@pluxel/hmr'],
			},
		})
		const api = new API({
			cwd: root,
			fs: {
				fileExists: (path) => (path === config || path === entry ? true : undefined),
				readFile: (path) =>
					path === config
						? configuration
						: path === entry
							? 'import {elysia} from "@pluxel/services/elysia"; import "./src/local.ts"; export const service = elysia();'
							: undefined,
			},
		})
		const snapshot = api.updateSnapshot({ openProjects: [config] })
		try {
			const project = snapshot.getProject(config)!
			expect(project.program.getSourceFile(source)).toBeDefined()
			expect(
				project.program.getSourceFileNames().some((path) => path.includes('/bun-types/')),
			).toBe(true)
			expect(project.program.getProgramDiagnostics()).toEqual([])
			expect(
				project.program
					.getSemanticDiagnostics(source)
					.filter((diagnostic) => diagnostic.category === DiagnosticCategory.Error)
					.map((diagnostic) => ({ code: diagnostic.code, text: diagnostic.text })),
			).toEqual([])
		} finally {
			snapshot.dispose()
			api.close()
		}
	},
)
