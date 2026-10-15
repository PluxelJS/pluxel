import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rolldown } from 'rolldown'
import { expect, it } from 'vitest'
import { lintGuardPlugin } from '../src/rolldown/plugins/lintGuardPlugin'

it.each(['oxlint.build.config.ts', 'vite.config.ts'])(
	'runs the packaged Vite+ linter with %s outside the workspace',
	async (configName) => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-lint-guard-'))
		try {
			await writeFile(
				join(root, 'package.json'),
				JSON.stringify({ name: 'lint-guard-fixture', private: true, type: 'module' }),
			)
			await writeFile(
				join(root, 'oxlint.config.ts'),
				"export default { rules: { 'no-debugger': 'error' } }\n",
			)
			await writeFile(
				join(root, configName),
				"import lint from './oxlint.config.ts'; export default { lint }\n",
			)
			const entry = join(root, 'entry.ts')
			await writeFile(entry, 'debugger; export const value = 1\n')
			const options = {
				input: entry,
				plugins: [lintGuardPlugin({ cwd: root, mode: 'enforce', paths: ['entry.ts'] })],
			}
			const invalidBundle = await rolldown(options)
			try {
				await expect(invalidBundle.generate({ format: 'esm' })).rejects.toThrow(/no-debugger/)
			} finally {
				await invalidBundle.close()
			}
			await writeFile(entry, 'export const value = 1\n')
			const bundle = await rolldown(options)
			try {
				const generated = await bundle.generate({ format: 'esm' })
				expect(
					generated.output.some((item) => item.type === 'chunk' && item.code.includes('value')),
				).toBe(true)
			} finally {
				await bundle.close()
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)
