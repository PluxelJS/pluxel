import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { workbenchFederationRemoteName } from '@pluxel/core/federation'
import {
	buildWorkbenchUiRemote,
	resolveWorkbenchFederationShared,
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

	it('resolves assets-prefixed references from the artifact root', async () => {
		await using fixture = await createFixture({
			'artifact/mf-manifest.json': JSON.stringify({
				metaData: { remoteEntry: { name: 'remoteEntry.js' } },
				exposes: [
					{
						name: 'ui-module',
						assets: { js: { sync: ['assets/index.js'], async: [] } },
					},
				],
			}),
			'artifact/remoteEntry.js': 'export const load = () => import("./assets/index.js")\n',
			'artifact/assets/index.js': 'export const stylesheet = "assets/index.css"\n',
			'artifact/assets/index.css': '.split-view { display: flex; }\n',
		})

		await expect(
			validateWorkbenchUiArtifact(join(fixture.path, 'artifact'), 'PluginWithUI'),
		).resolves.toMatchObject({ valid: true })
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
				minify: false,
			}),
			buildWorkbenchUiRemote({
				root,
				pluginName: 'PluginB',
				entryPath: join(root, 'src/ui/b.ts'),
				outDir: join(tempRoot, 'plugin-b'),
				publicPath: '/test/',
				minify: false,
				sourcemap: true,
			}),
		])

		for (const [index, result] of results.entries()) {
			await access(result.manifestPath)
			const outputFiles = await readdir(result.outDir, { recursive: true })
			expect(outputFiles.some((file) => String(file).endsWith('.map'))).toBe(index === 1)
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
		const results = await Promise.all(
			cases.map(({ root, pluginName }) =>
				buildWorkbenchUiRemote({
					root,
					pluginName,
					entryPath: join(root, 'src/ui/index.ts'),
					outDir: join(fixture.path, `dist/${pluginName}`),
					publicPath: '/test/',
					minify: false,
				}),
			),
		)

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
			minify: false,
		})
		const second = await buildWorkbenchUiRemote({
			root,
			pluginName: 'PluginWithUI',
			entryPath,
			outDir: join(fixture.path, 'pwui-test-2'),
			publicPath: '/test/',
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

	it('keeps the official manifest asset graph while externalizing host shared packages', async () => {
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
			minify: false,
		})

		const files = await readdir(join(outDir, 'assets'), { recursive: true })
		const jsFiles = files.filter((file) => String(file).endsWith('.js')).map(String)
		const contents = await Promise.all(
			jsFiles.map((file) => readFile(join(outDir, 'assets', file), 'utf-8')),
		)
		const allContents = contents.join('\n')
		const manifest = JSON.parse(await readFile(join(outDir, 'mf-manifest.json'), 'utf-8')) as {
			exposes?: Array<{ assets?: { js?: { async?: string[]; sync?: string[] } } }>
		}

		const assets = manifest.exposes?.[0]?.assets?.js
		expect([...(assets?.sync ?? []), ...(assets?.async ?? [])].length).toBeGreaterThan(0)
		expect(allContents).not.toContain('react.forward_ref')
	}, 45_000)

	it('reads shared package versions from OXC package metadata', async () => {
		await using fixture = await createFixture({
			'node_modules/react/package.json': JSON.stringify({
				name: 'react',
				version: '1.2.3',
				type: 'module',
				exports: {
					'.': './dist/index.js',
				},
			}),
			'node_modules/react/dist/index.js': 'export {}\n',
		})

		const resolved = resolveWorkbenchFederationShared(fixture.path)

		expect(resolved.signature).toContain('builder:pluxel@3')
		expect(resolved.signature).toContain('@module-federation/vite@1.16.16')
		expect(resolved.signature).toContain('vite@8.1.3')
		expect(resolved.signature).toContain('react@1.2.3')
		expect(resolved.shared).toMatchObject({
			react: {
				version: '1.2.3',
				singleton: true,
				import: false,
				requiredVersion: false,
			},
		})
	})
})
