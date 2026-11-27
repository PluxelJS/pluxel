import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const toolchainRequire = createRequire(require.resolve('@pluxel/rolldown/package.json'))
const bin = fileURLToPath(new URL('../bin/pluxel.mjs', import.meta.url))

it('builds the current project through the CLI bin and preserves its input options', async () => {
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({
			name: 'pluxel-cli-build-fixture',
			version: '1.0.0',
			type: 'module',
			exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' } },
			peerDependencies: { '@pluxel/core': '*', '@pluxel/host': '*' },
			peerDependenciesMeta: { '@pluxel/host': { optional: true } },
		}),
		'tsconfig.json': JSON.stringify({
			compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' },
			include: ['src'],
		}),
		'tsdown.config.ts': `
export default {
	entry: 'src/index.ts', format: 'esm', dts: false, minify: false,
	inputOptions(options) {
		return {
			...options,
			transform: {
				...options.transform,
				define: { ...options.transform?.define, __FIXTURE_INPUT__: JSON.stringify('preserved') },
			},
		}
	},
}
`,
		'src/index.ts': `
import { BasePlugin, Plugin } from '@pluxel/core'
declare const __FIXTURE_INPUT__: string
export const inputOverride = __FIXTURE_INPUT__
@Plugin() export class FixtureProvider extends BasePlugin {}
@Plugin() export class FixtureConsumer extends BasePlugin {
	constructor(readonly provider: FixtureProvider) { super() }
}
`,
	})
	const packages = resolve(fixture.path, 'node_modules/@pluxel')
	await mkdir(packages, { recursive: true })
	for (const name of ['rolldown', 'core', 'host']) {
		await symlink(
			dirname(toolchainRequire.resolve(`@pluxel/${name}/package.json`)),
			resolve(packages, name),
		)
	}
	const env = { ...process.env }
	delete env.NODE_OPTIONS
	delete env.NODE_PATH
	await exec(process.execPath, [bin, 'build'], { cwd: fixture.path, env, timeout: 60_000 })
	const { stdout } = await exec(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`const built = await import(process.argv[1]);
console.log(JSON.stringify([built.inputOverride, built.FixtureProvider.name, built.FixtureConsumer.name]))`,
			pathToFileURL(resolve(fixture.path, 'dist/index.mjs')).href,
		],
		{ cwd: fixture.path, env, timeout: 10_000 },
	)
	expect(JSON.parse(stdout)).toEqual(['preserved', 'FixtureProvider', 'FixtureConsumer'])
	const manifest = JSON.parse(await readFile(resolve(fixture.path, 'package.json'), 'utf8'))
	expect(manifest.pluxel).toMatchObject({ artifactRoot: 'dist', nodeArtifacts: true })
}, 90_000)

it('prepares clean types and builds two localized plugin packages in parallel', async () => {
	const messageFormat = await readFile(
		toolchainRequire.resolve('@inlang/plugin-message-format'),
		'utf8',
	)
	const names = ['orders', 'billing']
	await using fixture = await createDiskFixture(
		Object.fromEntries(
			names.flatMap((name) =>
				Object.entries({
					'package.json': JSON.stringify({
						name: `@fixture/${name}`,
						version: '1.0.0',
						type: 'module',
						files: ['dist'],
						exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' } },
						imports: {
							'#i18n': './.pluxel/i18n/index.js',
							'#i18n/messages': './.pluxel/i18n/messages.js',
						},
						peerDependencies: { '@pluxel/core': '*', '@pluxel/host': '*' },
					}),
					'project.inlang/settings.json': JSON.stringify({
						baseLocale: 'en',
						locales: ['en', 'zh-CN'],
						modules: ['./message-format.mjs'],
						'plugin.inlang.messageFormat': { pathPattern: './messages/{locale}.json' },
					}),
					'message-format.mjs': messageFormat,
					'messages/en.json': JSON.stringify({
						title: `${name} in English {total}`,
						unused: 'UNUSED_LOCALE_BODY',
					}),
					'messages/zh-CN.json': JSON.stringify({
						title: `${name} in Chinese {total}`,
						unused: 'UNUSED_LOCALE_BODY_ZH',
					}),
					'tsconfig.json': JSON.stringify({
						compilerOptions: {
							target: 'ESNext',
							module: 'ESNext',
							moduleResolution: 'Bundler',
							experimentalDecorators: true,
							skipLibCheck: true,
							strict: true,
						},
						include: ['src'],
					}),
					'tsdown.config.ts':
						'export default { entry: "src/index.ts", format: "esm", minify: false }',
					'src/index.ts': `
import { BasePlugin, Plugin } from '@pluxel/core'
import { resolveLocale } from '#i18n'
import { title } from '#i18n/messages'
@Plugin()
export class FixturePlugin extends BasePlugin {
	format(total: number, requested?: string) {
		return title({ total }, { locale: resolveLocale(requested) })
	}
}
`,
				}).map(([file, source]) => [`packages/${name}/${file}`, source]),
			),
		),
	)
	const dependencyRoot = resolve(fixture.path, 'node_modules/@pluxel')
	await mkdir(dependencyRoot, { recursive: true })
	for (const name of ['rolldown', 'core', 'host']) {
		await symlink(
			dirname(toolchainRequire.resolve(`@pluxel/${name}/package.json`)),
			resolve(dependencyRoot, name),
		)
	}
	const env = { ...process.env }
	delete env.NODE_OPTIONS
	delete env.NODE_PATH
	const roots = names.map((name) => resolve(fixture.path, 'packages', name))
	const tsc = resolve(dirname(require.resolve('typescript/package.json')), 'bin/tsc')
	const checkTypes = (cwd: string) =>
		exec(process.execPath, [tsc, '--noEmit'], {
			cwd,
			env,
			timeout: 30_000,
		})
	await exec(process.execPath, [bin, 'i18n', '--root', roots[0]!], {
		cwd: fixture.path,
		env,
		timeout: 30_000,
	})
	await checkTypes(roots[0]!)
	await rm(resolve(roots[0]!, '.pluxel'), { recursive: true })

	const builds = await Promise.allSettled(
		roots.map((cwd) => exec(process.execPath, [bin, 'build'], { cwd, env, timeout: 60_000 })),
	)
	for (const result of builds) if (result.status === 'rejected') throw result.reason
	for (const [index, root] of roots.entries()) {
		await checkTypes(root)
		const artifact = await readFile(resolve(root, 'dist/index.mjs'), 'utf8')
		expect(artifact).toContain(`${names[index]} in Chinese`)
		expect(artifact).not.toMatch(/UNUSED_LOCALE_BODY|node:async_hooks|#i18n/)
		const otherName = names[1 - index]
		expect(artifact).not.toContain(`${otherName} in Chinese`)
		await rm(resolve(root, '.pluxel'), { recursive: true })
		await rm(resolve(root, 'messages'), { recursive: true })
		const { stdout } = await exec(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`const { FixturePlugin } = await import('./dist/index.mjs')
				console.log(FixturePlugin.prototype.format(5, 'zh_cn'))`,
			],
			{ cwd: root, env, timeout: 10_000 },
		)
		expect(stdout.trim()).toBe(`${names[index]} in Chinese 5`)
	}
}, 90_000)
