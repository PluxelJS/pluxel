import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPluginUiRemote, disposePluginUiBuildSchedulers } from '../src/plugin-build'

afterEach(() => {
	disposePluginUiBuildSchedulers()
})

describe('buildPluginUiRemote', () => {
	it(
		'builds multiple remotes from the same package root without cross-build corruption',
		async () => {
			const workspaceTmpDir = resolve(process.cwd(), '.tmp')
			await mkdir(workspaceTmpDir, { recursive: true })
			const tempRoot = await mkdtemp(join(workspaceTmpDir, 'hmr-plugin-build-'))
			try {
				const root = join(tempRoot, 'packages/plugins/demo')
				await mkdir(join(root, 'src/ui'), { recursive: true })
				await mkdir(join(root, 'node_modules/react'), { recursive: true })
				await writeFile(
					join(root, 'package.json'),
					JSON.stringify({
						name: '@pluxel/plugins-demo',
						private: true,
						type: 'module',
					}),
					'utf-8',
				)
				await writeFile(join(root, 'src/ui/a.ts'), 'export default { id: "a" }\n', 'utf-8')
				await writeFile(join(root, 'src/ui/b.ts'), 'export default { id: "b" }\n', 'utf-8')
				await writeFile(
					join(root, 'node_modules/react/package.json'),
					JSON.stringify({
						name: 'react',
						version: '19.2.0',
						main: 'index.js',
					}),
					'utf-8',
				)
				await writeFile(join(root, 'node_modules/react/index.js'), 'module.exports = {}\n', 'utf-8')

				const results = await Promise.all([
					buildPluginUiRemote({
						root,
						pluginName: 'PluginA',
						entryPath: join(root, 'src/ui/a.ts'),
						outDir: join(tempRoot, 'plugin-a'),
						publicPath: '/test/',
						sharedPackages: ['react'],
						minify: false,
					}),
					buildPluginUiRemote({
						root,
						pluginName: 'PluginB',
						entryPath: join(root, 'src/ui/b.ts'),
						outDir: join(tempRoot, 'plugin-b'),
						publicPath: '/test/',
						sharedPackages: ['react'],
						minify: false,
					}),
				])

				for (const result of results) {
					await access(result.manifestPath)
					const manifest = JSON.parse(await readFile(result.manifestPath, 'utf-8')) as {
						metaData?: { remoteEntry?: { name?: string } }
					}
					expect(manifest.metaData?.remoteEntry?.name).toBe('remoteEntry.js')
				}
			} finally {
				await rm(tempRoot, { recursive: true, force: true })
			}
		},
		20_000,
	)

	it(
		'builds the same remote repeatedly without reusing process-local federation state',
		async () => {
			const root = resolve(process.cwd(), 'packages/plugins/host')
			const sharedPackages = [
				'react',
				'react-dom',
				'@mantine/core',
				'@mantine/hooks',
				'@pluxel/runtime/web/ui',
			]

			const first = await buildPluginUiRemote({
				root,
				pluginName: 'PluginWithUI',
				entryPath: resolve('./packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx'),
				outDir: resolve('./.tmp/pwui-test-1'),
				publicPath: '/test/',
				sharedPackages,
				minify: false,
			})
			const second = await buildPluginUiRemote({
				root,
				pluginName: 'PluginWithUI',
				entryPath: resolve('./packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx'),
				outDir: resolve('./.tmp/pwui-test-2'),
				publicPath: '/test/',
				sharedPackages,
				minify: false,
			})

			await access(first.manifestPath)
			await access(second.manifestPath)
		},
		20_000,
	)
})
