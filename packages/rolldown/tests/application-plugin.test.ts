import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { UserConfig } from 'tsdown'
import { pluxel } from '../src/application'

describe('tsdown application plugin', () => {
	it('preserves ordinary plugin order and native output preferences while installing the freezer once', async () => {
		const before = { name: 'external-before' }
		const after = { name: 'external-after' }
		const plugin = pluxel({ variant: 'headless' })
		const config: UserConfig = {
			entry: './app.ts',
			outDir: 'release',
			minify: false,
			sourcemap: 'hidden',
			clean: false,
			plugins: [before, Promise.resolve([plugin]), after],
			outputOptions: { sourcemapExcludeSources: true },
		}
		const result = (await plugin.tsdownConfig!(config, {})) as UserConfig
		expect(result).toMatchObject({
			minify: false,
			sourcemap: 'hidden',
			clean: false,
			outputOptions: { sourcemapExcludeSources: true },
		})
		expect(result.outDir).toMatch(/release$/)
		const plugins = (await result.plugins) as unknown[]
		expect(plugins[0]).toBe(before)
		expect(plugins.at(-1)).toBe(after)
		expect(plugins).not.toContain(plugin)
		const generated = plugins[1] as { name: string }[]
		expect(
			generated.filter((entry) => entry.name === 'pluxel-static-application-entry'),
		).toHaveLength(1)
	})

	it('rejects ambiguous application entries before running build hooks', async () => {
		const plugin = pluxel()
		await expect(plugin.tsdownConfig!({ entry: ['one.ts', 'two.ts'] }, {})).rejects.toThrow(
			'exactly one application module',
		)
		await expect(
			plugin.tsdownConfig!({ entry: './app.ts', platform: 'browser' }, {}),
		).rejects.toThrow('node platform')
		await expect(plugin.tsdownConfig!({ entry: './app.ts', format: 'cjs' }, {})).rejects.toThrow(
			'esm format',
		)
	})
})

it('freezes a Host-only application without evaluating its async factory and runs fresh configuration outside the workspace', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-host-application-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'host-only', type: 'module' }),
		)
		await writeFile(
			join(root, 'app.ts'),
			`
import { defineConfig, defineHostService } from '@pluxel/host';
import { defineContextCapability, installRootCapability } from '@pluxel/core/host';
const Selected = defineContextCapability('Selected');
export default defineConfig(async ({env}) => {
  if (env.APPLICATION_STAGE !== 'run') throw new Error('FACTORY_EXECUTED_DURING_BUILD');
  return { plugins: [], services: [defineHostService({name:'Selected',capabilities:[installRootCapability(Selected,{create:()=>env.APPLICATION_VALUE})],prepare({effects}) { process.stdout.write('SERVICE_READY:'+env.APPLICATION_VALUE+'\\n'); effects.defer(()=>{process.stdout.write('SERVICE_CLOSED\\n')}) }})] };
});`,
		)
		const script = join(root, 'build.mts')
		await writeFile(
			script,
			`
import { build } from ${JSON.stringify(import.meta.resolve('tsdown'))};
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
await build({cwd:${JSON.stringify(root)},entry:'app.ts',minify:false,plugins:[pluxel({variant:'headless',launcher:'host',lint:false})],config:false});`,
		)
		await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
			timeout: 30000,
			maxBuffer: 4 * 1024 * 1024,
		})
		const bundled = await readFile(join(root, 'dist/app.mjs'), 'utf8')
		expect(bundled).not.toMatch(
			/@pluxel\/runtime|NodeElysiaApplicationCarrier|PGlite|createPostgresDatabaseAdapter/,
		)
		await rm(join(root, 'node_modules'), { recursive: true })
		const child = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
const application = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/app.mjs')).href)});
if ('fetch' in application || 'address' in application) throw new Error('UNSELECTED_HTTP');
await application.stop();`,
			],
			{
				env: { ...process.env, APPLICATION_STAGE: 'run', APPLICATION_VALUE: 'fresh' },
				timeout: 10000,
			},
		)
		expect(child.stdout).toContain('SERVICE_READY:fresh')
		expect(child.stdout).toContain('SERVICE_CLOSED')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 60000)
