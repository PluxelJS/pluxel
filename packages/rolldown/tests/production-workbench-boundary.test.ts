import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)

it('bridges an installed target through a relocated Workbench application and diagnoses a wrong version', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-workbench-deployment-'))
	const put = async (path: string, value: string) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, value)
	}
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host', 'workbench']) {
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		}
		await put(
			'package.json',
			JSON.stringify({ name: 'workbench-deployment-probe', type: 'module' }),
		)
		await put(
			'mutable/node_modules/installed-target/package.json',
			JSON.stringify({
				name: 'installed-target',
				type: 'module',
				exports: './index.mjs',
				pluxel: { workbenchCapnweb: '0.12.0' },
			}),
		)
		await put(
			'mutable/node_modules/installed-target/index.mjs',
			`
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition } from '@pluxel/core/toolchain'
import { RpcTarget } from 'capnweb'
class Dynamic extends BasePlugin {
 init() {
  if (RpcTarget !== globalThis.__hostRpcTarget) throw new Error('WORKBENCH_TARGET_IDENTITY_MISMATCH')
  process.stdout.write('WORKBENCH_TARGET_SHARED\\n')
 }
}
Plugin()(Dynamic)
__setPluginDefinition(Dynamic, { abiVersion: 2, kind: 'plugin', definition: { entry: { kind: 'package-root', packageName: 'installed-target' }, exportName: 'Dynamic' } })
export { Dynamic }
`,
		)
		const capnwebDirectory = 'mutable/node_modules/installed-target/node_modules/capnweb'
		await put(
			`${capnwebDirectory}/package.json`,
			JSON.stringify({
				name: 'capnweb',
				version: '0.12.0',
				type: 'module',
				exports: './index.mjs',
			}),
		)
		await put(`${capnwebDirectory}/index.mjs`, 'export class RpcTarget {}')
		await put('mutable/entries/installed.mjs', "export * from 'installed-target'")
		await put(
			'app.ts',
			`
import { defineHostApplication } from '@pluxel/host'
import { dynamicSource } from '@pluxel/host/dynamic'
import { workbenchService } from '@pluxel/workbench/service'
import { WorkbenchHost } from '@pluxel/workbench/server'
export default defineHostApplication(() => ({
 name: 'workbench-boundary',
 plugins: [],
 services: [workbenchService()],
 sources: [dynamicSource({ kind: 'directory', path: ${JSON.stringify(join(root, 'mutable/entries'))}, include: ['*.mjs'] })],
 prepare: ({ host }) => {
  const session = host.ctx.require(WorkbenchHost).createSession({ provider: 'probe', subject: 'reader' }, () => {})
  globalThis.__hostRpcTarget = Object.getPrototypeOf(session.target.constructor)
  session.dispose()
 },
 state: { initial: { autoStart: [{ definition: { entry: { kind: 'package-root', packageName: 'installed-target' }, exportName: 'Dynamic' }, variant: 'default' }] } },
}))
`,
		)
		const script = join(root, 'build.mts')
		await put(
			'build.mts',
			`
import { build } from ${JSON.stringify(import.meta.resolve('tsdown'))}
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)}
await build({ cwd: ${JSON.stringify(root)}, entry: 'app.ts', minify: false, plugins: [pluxel({ variant: 'workbench', launcher: 'host', lint: false })], config: false })
`,
		)
		await exec(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
			timeout: 60000,
			maxBuffer: 4 * 1024 * 1024,
		})
		const deployed = join(root, 'relocated')
		await rename(join(root, 'dist'), deployed)
		await rm(join(root, 'app.ts'))
		const bootstrap = await readFile(join(deployed, 'app.mjs'), 'utf8')
		expect(bootstrap).toContain('workbenchCapnwebVersion')
		const run = async () =>
			await exec(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
					const application = await import(${JSON.stringify(pathToFileURL(join(deployed, 'app.mjs')).href)})
try { await application.start() } finally { await application.stop() }
`,
				],
				{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
			)
		const compatible = await run()
		expect(compatible.stdout).toContain('WORKBENCH_TARGET_SHARED')
		await put(
			`${capnwebDirectory}/package.json`,
			JSON.stringify({
				name: 'capnweb',
				version: '0.13.0',
				type: 'module',
				exports: './index.mjs',
			}),
		)
		await expect(run()).rejects.toThrow(
			/installed-target declares capnweb 0\.12\.0, resolves 0\.13\.0; host Workbench supports 0\.12\.0/,
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 90_000)
