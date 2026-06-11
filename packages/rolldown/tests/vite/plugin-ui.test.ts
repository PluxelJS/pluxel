import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createFixture } from 'fs-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import { join, resolve } from 'pathe'
import {
	buildPluginUiRemote,
	disposePluginUiBuildSchedulers,
	resolvePluginUiBuildSignature,
} from '../../src/vite/plugin-ui'

const workspaceRoot = fileURLToPath(new URL('../../../..', import.meta.url))

afterEach(() => {
	disposePluginUiBuildSchedulers()
})

describe('buildPluginUiRemote', () => {
	it('builds multiple remotes from the same package root without cross-build corruption', async () => {
		await using fixture = await createFixture({
			'packages/plugins/demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-demo',
				private: true,
				type: 'module',
			}),
			'packages/plugins/demo/src/ui/a.ts': 'export default { id: "a" }\n',
			'packages/plugins/demo/src/ui/b.ts': 'export default { id: "b" }\n',
			'packages/plugins/demo/node_modules/react/package.json': JSON.stringify({
				name: 'react',
				version: '19.2.0',
				main: 'index.js',
			}),
			'packages/plugins/demo/node_modules/react/index.js': 'module.exports = {}\n',
		})

		const tempRoot = fixture.path
		const root = join(tempRoot, 'packages/plugins/demo')
		const stickyVirtual = join(root, 'node_modules/__mf__virtual/sticky.txt')
		const stickyTemp = join(root, '.__mf__temp/sticky.txt')
		await mkdir(join(root, 'node_modules/__mf__virtual'), { recursive: true })
		await mkdir(join(root, '.__mf__temp'), { recursive: true })
		await writeFile(stickyVirtual, 'keep me\n')
		await writeFile(stickyTemp, 'keep me\n')

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
		await expect(readFile(stickyVirtual, 'utf-8')).resolves.toBe('keep me\n')
		await expect(readFile(stickyTemp, 'utf-8')).resolves.toBe('keep me\n')
		await expect(
			readdir(join(root, '.pluxel/vite-plugin-ui-cache')).catch((): string[] => []),
		).resolves.toEqual([])
	}, 45_000)

	it('builds the same remote repeatedly without reusing process-local federation state', async () => {
		const root = resolve(workspaceRoot, 'packages/plugins/host')
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
			entryPath: resolve(workspaceRoot, 'packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx'),
			outDir: resolve(workspaceRoot, '.tmp/pwui-test-1'),
			publicPath: '/test/',
			sharedPackages,
			minify: false,
		})
		const second = await buildPluginUiRemote({
			root,
			pluginName: 'PluginWithUI',
			entryPath: resolve(workspaceRoot, 'packages/plugins/host/src/demo/PluginWithUI/ui/index.tsx'),
			outDir: resolve(workspaceRoot, '.tmp/pwui-test-2'),
			publicPath: '/test/',
			sharedPackages,
			minify: false,
		})

		await expect(access(first.manifestPath)).resolves.toBeUndefined()
		await expect(access(second.manifestPath)).resolves.toBeUndefined()
	}, 45_000)

	it('runs user Vite plugins before building the federated UI remote', async () => {
		await using fixture = await createFixture({
			'packages/plugins/demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-demo',
				private: true,
				type: 'module',
			}),
			'packages/plugins/demo/src/ui/index.ts': `
const marker = "__PLUGIN_UI_MARKER__"
export default { marker }
`,
			'packages/plugins/demo/node_modules/react/package.json': JSON.stringify({
				name: 'react',
				version: '19.2.0',
				main: 'index.js',
			}),
			'packages/plugins/demo/node_modules/react/index.js': 'module.exports = {}\n',
		})

		const root = join(fixture.path, 'packages/plugins/demo')
		const outDir = join(fixture.path, 'dist/plugin-ui')
		await buildPluginUiRemote({
			root,
			pluginName: 'PluginWithTransform',
			entryPath: join(root, 'src/ui/index.ts'),
			outDir,
			publicPath: '/test/',
			sharedPackages: ['react'],
			minify: false,
			vite: {
				plugins: [
					{
						name: 'test:plugin-ui-transform',
						transform: {
							filter: {
								id: /\/src\/ui\/index\.ts$/,
							},
							handler(code) {
								return code.replace('__PLUGIN_UI_MARKER__', 'transformed-by-user-plugin')
							},
						},
					},
				],
			},
		})

		const files = await readdir(outDir, { recursive: true })
		const jsFiles = files.filter((file) => String(file).endsWith('.js')).map(String)
		const contents = await Promise.all(
			jsFiles.map((file) => readFile(join(outDir, file), 'utf-8')),
		)
		expect(contents.join('\n')).toContain('transformed-by-user-plugin')
		expect(contents.join('\n')).not.toContain('__PLUGIN_UI_MARKER__')
	}, 45_000)

	it('creates a stable signature for user build additions', () => {
		const signature = resolvePluginUiBuildSignature({
			plugins: [{ name: 'test:plugin-a' }, [{ name: 'test:plugin-b' }]],
			resolve: {
				alias: {
					'@demo/generated': '/abs/generated.ts',
				},
			},
			define: {
				__SCHEMA_VERSION__: JSON.stringify('schema-v1'),
			},
			build: {
				target: 'chrome120',
			},
			css: {
				modules: {
					localsConvention: 'camelCaseOnly',
				},
			},
		})

		expect(signature).toContain('plugins:test:plugin-a|test:plugin-b')
		expect(signature).toContain('resolve:')
		expect(signature).toContain('@demo/generated')
		expect(signature).toContain('define:')
		expect(signature).toContain('__SCHEMA_VERSION__')
		expect(signature).toContain('build:')
		expect(signature).toContain('chrome120')
		expect(signature).toContain('css:')
		expect(signature).toContain('camelCaseOnly')
	})
})
