import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'
import { expect, it } from 'vitest'
import { staticFrameworkSingletonPlugin } from '../src/cli/framework-singletons'

it('shares application-selected framework root, subpath and relative imports across physical peer copies', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-framework-singletons-'))
	const put = async (path: string, content: string) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, content)
	}
	try {
		for (const directory of [
			'node_modules/@example/service',
			'plugin/node_modules/@example/service',
		]) {
			await put(
				`${directory}/package.json`,
				JSON.stringify({
					name: '@example/service',
					type: 'module',
					exports: { '.': './index.js', './http': './http.js' },
				}),
			)
			await put(`${directory}/http.js`, 'export const token = Symbol("http")')
			await put(`${directory}/index.js`, 'export { token } from "./http.js"')
		}
		await put('plugin/index.js', 'export { token as pluginToken } from "@example/service/http"')
		await put(
			'app.js',
			'import { token } from "@example/service"; import { pluginToken } from "./plugin/index.js"; export const same = token === pluginToken',
		)
		const entry = join(root, 'app.js')
		const bundle = await rolldown({
			input: entry,
			plugins: [staticFrameworkSingletonPlugin(entry, ['@example/service/http'])],
		})
		try {
			await bundle.write({ file: join(root, 'out.mjs'), format: 'esm' })
		} finally {
			await bundle.close()
		}
		const application = await import(pathToFileURL(join(root, 'out.mjs')).href)
		expect(application.same).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
