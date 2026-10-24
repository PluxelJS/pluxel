import { execFile } from 'node:child_process'
import { mkdir, readFile, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createDiskFixture } from '@pluxel/test/fixtures'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const toolchainRequire = createRequire(require.resolve('@pluxel/rolldown/package.json'))

it('builds the current project through the CLI bin and preserves its input options', async () => {
	await using fixture = await createDiskFixture({
		'package.json': JSON.stringify({
			name: 'pluxel-cli-build-fixture',
			version: '1.0.0',
			type: 'module',
			exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' } },
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
	for (const name of ['rolldown', 'core']) {
		await symlink(
			dirname(toolchainRequire.resolve(`@pluxel/${name}/package.json`)),
			resolve(packages, name),
		)
	}
	const env = { ...process.env }
	delete env.NODE_OPTIONS
	delete env.NODE_PATH
	const bin = fileURLToPath(new URL('../bin/pluxel.mjs', import.meta.url))
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
