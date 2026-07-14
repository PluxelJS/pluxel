import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { workbenchFederationRemoteName } from '@pluxel/core/federation'
import {
	buildWorkbenchUiRemote,
	resolveWorkbenchFederationShared,
	resolveWorkbenchUiBuildSignature,
} from '../../src/vite/workbench-ui'
import { validateWorkbenchUiArtifact } from '../../src/workbench/artifact'

describe('buildWorkbenchUiRemote', () => {
	it('rejects partial cached artifacts including missing lazy chunks', async () => {
		await using fixture = await createFixture({
			'artifact/mf-manifest.json': JSON.stringify({
				metaData: { remoteEntry: { name: 'remoteEntry.js' } },
				exposes: [{ name: 'ui-module', assets: { js: { sync: [], async: [] } } }],
			}),
			'artifact/remoteEntry.js': 'export const load = () => import("./assets/missing.js")\n',
		})

		await expect(
			validateWorkbenchUiArtifact(join(fixture.path, 'artifact'), 'PluginWithUI'),
		).resolves.toMatchObject({
			valid: false,
			reason: 'artifact asset missing: assets/missing.js',
		})
	})

	it('rejects artifact references that escape the published remote directory', async () => {
		await using fixture = await createFixture({
			'artifact/mf-manifest.json': JSON.stringify({
				metaData: { remoteEntry: { name: 'remoteEntry.js' } },
				exposes: [{ name: 'ui-module', assets: { js: { sync: [], async: [] } } }],
			}),
			'artifact/remoteEntry.js': 'export const load = () => import("../outside.js")\n',
			'outside.js': 'export default {}\n',
		})

		await expect(
			validateWorkbenchUiArtifact(join(fixture.path, 'artifact'), 'PluginWithUI'),
		).resolves.toMatchObject({
			valid: false,
			reason: 'invalid artifact asset reference in remoteEntry.js: ../outside.js',
		})
	})

	it('builds multiple remotes from the same package root without cross-build corruption', async () => {
		await using fixture = await createFixture({
			'packages/plugins/demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-demo',
				private: true,
				type: 'module',
				dependencies: {
					react: '19.2.0',
				},
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
			buildWorkbenchUiRemote({
				root,
				pluginName: 'PluginA',
				entryPath: join(root, 'src/ui/a.ts'),
				outDir: join(tempRoot, 'plugin-a'),
				publicPath: '/test/',
				sharedPackages: ['react'],
				minify: false,
			}),
			buildWorkbenchUiRemote({
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
			readdir(join(root, '.pluxel/vite-workbench-ui-cache')).catch((): string[] => []),
		).resolves.toEqual([])
	}, 45_000)

	it('builds remotes from different package roots without cross-build corruption', async () => {
		await using fixture = await createFixture({
			'packages/plugins/yiqicha/package.json': JSON.stringify({
				name: '@pluxel/plugin-yiqicha',
				private: true,
				type: 'module',
				dependencies: { react: '19.2.0' },
			}),
			'packages/plugins/yiqicha/src/ui/index.ts': `
export const marker = "yiqicha-workbench-ui"
export default { marker }
`,
			'packages/plugins/yiqicha/node_modules/react/package.json': JSON.stringify({
				name: 'react',
				version: '19.2.0',
				main: 'index.js',
			}),
			'packages/plugins/yiqicha/node_modules/react/index.js': 'module.exports = {}\n',
			'packages/plugins/zhipu/package.json': JSON.stringify({
				name: '@pluxel/plugin-zhipu',
				private: true,
				type: 'module',
				dependencies: { react: '19.2.0' },
			}),
			'packages/plugins/zhipu/src/ui/index.ts': `
export const marker = "zhipu-workbench-ui"
export default { marker }
`,
			'packages/plugins/zhipu/node_modules/react/package.json': JSON.stringify({
				name: 'react',
				version: '19.2.0',
				main: 'index.js',
			}),
			'packages/plugins/zhipu/node_modules/react/index.js': 'module.exports = {}\n',
		})

		const cases = [
			{
				root: join(fixture.path, 'packages/plugins/yiqicha'),
				pluginName: 'YiqichaProviderPlugin',
				marker: 'yiqicha-workbench-ui',
			},
			{
				root: join(fixture.path, 'packages/plugins/zhipu'),
				pluginName: 'ZhipuProviderPlugin',
				marker: 'zhipu-workbench-ui',
			},
		] as const
		let activeBuilds = 0
		let maximumActiveBuilds = 0

		const results = await Promise.all(
			cases.map(({ root, pluginName }) =>
				buildWorkbenchUiRemote({
					root,
					pluginName,
					entryPath: join(root, 'src/ui/index.ts'),
					outDir: join(fixture.path, `dist/${pluginName}`),
					publicPath: '/test/',
					sharedPackages: ['react'],
					minify: false,
					vite: {
						plugins: [
							{
								name: `test:track-${pluginName}`,
								async buildStart() {
									activeBuilds += 1
									maximumActiveBuilds = Math.max(maximumActiveBuilds, activeBuilds)
									try {
										await new Promise((resolve) => setTimeout(resolve, 25))
									} finally {
										activeBuilds -= 1
									}
								},
							},
						],
					},
				}),
			),
		)
		expect(maximumActiveBuilds).toBe(1)

		for (const [index, result] of results.entries()) {
			const expected = cases[index]!
			const validation = await validateWorkbenchUiArtifact(result.outDir, expected.pluginName)
			expect(validation.valid).toBe(true)
			if (!validation.valid) continue
			expect(validation.manifest.name ?? validation.manifest.metaData?.name).toBe(
				workbenchFederationRemoteName(expected.pluginName),
			)

			const files = await readdir(result.outDir, { recursive: true })
			const jsFiles = files.filter((file) => String(file).endsWith('.js')).map(String)
			const contents = await Promise.all(
				jsFiles.map((file) => readFile(join(result.outDir, file), 'utf-8')),
			)
			const output = contents.join('\n')
			expect(output).toContain(expected.marker)
			expect(output).not.toContain(cases[1 - index]!.marker)
		}
	}, 45_000)

	it('builds the same remote repeatedly without reusing process-local federation state', async () => {
		await using fixture = await createFixture({
			'packages/plugins/demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-demo',
				private: true,
				type: 'module',
				dependencies: {
					react: '19.2.0',
				},
			}),
			'packages/plugins/demo/src/ui/index.ts': `
export const marker = "same-remote"
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
		const entryPath = join(root, 'src/ui/index.ts')

		const first = await buildWorkbenchUiRemote({
			root,
			pluginName: 'PluginWithUI',
			entryPath,
			outDir: join(fixture.path, 'pwui-test-1'),
			publicPath: '/test/',
			sharedPackages: ['react'],
			minify: false,
		})
		const second = await buildWorkbenchUiRemote({
			root,
			pluginName: 'PluginWithUI',
			entryPath,
			outDir: join(fixture.path, 'pwui-test-2'),
			publicPath: '/test/',
			sharedPackages: ['react'],
			minify: false,
		})

		for (const result of [first, second]) {
			await access(result.manifestPath)
			const files = await readdir(result.outDir, { recursive: true })
			const jsFiles = files.filter((file) => String(file).endsWith('.js')).map(String)
			const contents = await Promise.all(
				jsFiles.map((file) => readFile(join(result.outDir, file), 'utf-8')),
			)
			expect(contents.join('\n')).toContain('same-remote')
		}
	}, 45_000)

	it('runs user Vite plugins before building the federated UI remote', async () => {
		await using fixture = await createFixture({
			'packages/plugins/demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-demo',
				private: true,
				type: 'module',
				dependencies: {
					react: '19.2.0',
				},
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
		const outDir = join(fixture.path, 'dist/workbench-ui')
		await buildWorkbenchUiRemote({
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
						name: 'test:workbench-ui-transform',
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
		const contents = await Promise.all(jsFiles.map((file) => readFile(join(outDir, file), 'utf-8')))
		expect(contents.join('\n')).toContain('transformed-by-user-plugin')
		expect(contents.join('\n')).not.toContain('__PLUGIN_UI_MARKER__')
	}, 45_000)

	it('waits for host shared initialization before importing exposed entry chunks', async () => {
		await using fixture = await createFixture({
			'packages/plugins/demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-demo',
				private: true,
				type: 'module',
				dependencies: {
					react: '19.2.0',
				},
			}),
			'packages/plugins/demo/src/ui/index.ts': `
import { forwardRef } from 'react'

export const Component = forwardRef(() => null)
export default { Component }
`,
			'packages/plugins/demo/node_modules/react/package.json': JSON.stringify({
				name: 'react',
				version: '19.2.0',
				main: 'index.js',
			}),
			'packages/plugins/demo/node_modules/react/index.js':
				'exports.forwardRef = (render) => ({ $$typeof: Symbol.for("react.forward_ref"), render })\n',
		})

		const root = join(fixture.path, 'packages/plugins/demo')
		const outDir = join(fixture.path, 'dist/workbench-ui')
		await buildWorkbenchUiRemote({
			root,
			pluginName: 'PluginWithTopLevelShared',
			entryPath: join(root, 'src/ui/index.ts'),
			outDir,
			publicPath: '/test/',
			sharedPackages: ['react'],
			minify: false,
		})

		const files = await readdir(join(outDir, 'assets'), { recursive: true })
		const jsFiles = files.filter((file) => String(file).endsWith('.js')).map(String)
		const contents = await Promise.all(
			jsFiles.map((file) => readFile(join(outDir, 'assets', file), 'utf-8')),
		)
		const allContents = contents.join('\n')
		const exposesChunk = contents.find((code) => code.includes('importExposedModule')) ?? ''
		const manifest = JSON.parse(await readFile(join(outDir, 'mf-manifest.json'), 'utf-8')) as {
			exposes?: Array<{ assets?: { js?: { async?: string[]; sync?: string[] } } }>
		}

		expect(exposesChunk).toContain('__pluxelMfRemoteInitPromise')
		expect(exposesChunk).toContain('__mf_init__virtual:mf:__mfe_internal__')
		expect(exposesChunk).not.toContain('hostAutoInit')
		expect(exposesChunk.indexOf('await __pluxelMfRemoteInitPromise')).toBeLessThan(
			exposesChunk.indexOf('const importModule = await importExposedModule'),
		)
		expect(manifest.exposes?.[0]?.assets?.js).toMatchObject({ async: [], sync: [] })
		expect(allContents).not.toContain('react.forward_ref')
	}, 45_000)

	it('creates a stable signature for user build additions', () => {
		const signature = resolveWorkbenchUiBuildSignature({
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

	it('reads shared package versions from OXC package metadata', async () => {
		await using fixture = await createFixture({
			'node_modules/shared-exported/package.json': JSON.stringify({
				name: 'shared-exported',
				version: '1.2.3',
				type: 'module',
				exports: {
					'.': './dist/index.js',
				},
			}),
			'node_modules/shared-exported/dist/index.js': 'export {}\n',
		})

		const resolved = resolveWorkbenchFederationShared(fixture.path, ['shared-exported'])

		expect(resolved.signature).toContain('builder:pluxel@1')
		expect(resolved.signature).toContain('@module-federation/vite@1.16.16')
		expect(resolved.signature).toContain('vite@8.1.3')
		expect(resolved.signature).toContain('shared:shared-exported@1.2.3')
		expect(resolved.shared).toMatchObject({
			'shared-exported': {
				version: '1.2.3',
				singleton: true,
				import: false,
				requiredVersion: false,
			},
		})
	})
})
