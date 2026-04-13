import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'pathe'
import { afterEach, describe, expect, it } from 'vitest'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { buildPluginUiRemote, disposePluginUiBuildSchedulers } from '../src/plugin-build'

const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))

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
	}, 20_000)

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

		await access(first.manifestPath)
		await access(second.manifestPath)
	}, 20_000)

	it('keeps legacy federation temp directories untouched while reusing child-process isolation', async () => {
		await using fixture = await createFixture({
			'packages/plugins/demo/package.json': JSON.stringify({
				name: '@pluxel/plugins-demo',
				private: true,
				type: 'module',
			}),
			'packages/plugins/demo/src/ui/a.ts': 'export default { id: "a" }\n',
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

		const result = await buildPluginUiRemote({
			root,
			pluginName: 'PluginA',
			entryPath: join(root, 'src/ui/a.ts'),
			outDir: join(tempRoot, 'plugin-a'),
			publicPath: '/test/',
			sharedPackages: ['react'],
			minify: false,
		})

		await access(result.manifestPath)
		await expect(readFile(stickyVirtual, 'utf-8')).resolves.toBe('keep me\n')
		await expect(readFile(stickyTemp, 'utf-8')).resolves.toBe('keep me\n')
		await expect(
			readdir(join(root, '.pluxel/vite-plugin-ui-cache')).catch((): string[] => []),
		).resolves.toEqual([])
	}, 20_000)
})
