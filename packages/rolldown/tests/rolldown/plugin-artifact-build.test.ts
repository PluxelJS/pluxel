import { readFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { rolldown } from 'rolldown'
import { describe, expect, it } from 'vitest'
import { pluginArtifactBuildPlugin } from '../../src/rolldown/plugins/pluginArtifactBuildPlugin.ts'

describe('pluginArtifactBuildPlugin', () => {
	it('lowers a Node declaration and publishes its Node ESM artifact', async () => {
		await using fixture = await createFixture({
			'src/index.ts':
				"import { defineNodeModule } from '@pluxel/runtime'\nexport const task = defineNodeModule(import.meta.url, './task.ts')\n",
			'src/task.ts': 'export const answer = 42\n',
		})
		const bundle = await rolldown({
			input: `${fixture.path}/src/index.ts`,
			external: ['@pluxel/runtime'],
			plugins: [
				pluginArtifactBuildPlugin({
					root: fixture.path,
					buildDir: 'dist',
					workbench: false,
					node: { minify: false },
				}),
			],
		})
		await bundle.write({ dir: `${fixture.path}/dist`, format: 'esm' })
		await bundle.close()

		const server = await readFile(`${fixture.path}/dist/index.js`, 'utf8')
		const key = server.match(
			/defineNodeModule\(import\.meta\.url,\s*['"]\.\/task\.ts['"],\s*['"]([^'"]+)/,
		)?.[1]
		expect(key).toMatch(/^node-[a-f\d]{16}$/)
		const artifact = await readFile(`${fixture.path}/dist/artifacts/node/${key}.mjs`, 'utf8')
		expect(artifact).toContain('answer')
		expect(artifact).not.toContain('@pluxel/runtime')
	})
})
