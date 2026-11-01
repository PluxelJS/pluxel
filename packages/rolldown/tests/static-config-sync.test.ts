import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

it('binds a standalone config writer to manifest facts before preparation and Plugin startup', async () => {
	const temporary = await mkdtemp(join(tmpdir(), 'pluxel-static-config-sync-'))
	const root = join(temporary, 'source')
	const deployed = join(temporary, 'delivery')
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host']) {
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		}
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'static-config-sync', type: 'module' }),
		)
		await writeFile(
			join(root, 'app.ts'),
			`
import { BasePlugin, Plugin, pluginNodeAddressOf } from '@pluxel/core';
import { defineHostApplication, type PluginHost } from '@pluxel/host';
const runtime = globalThis as typeof globalThis & { __staticSyncHost?: PluginHost };
@Plugin()
class Probe extends BasePlugin {
 init() { console.log('STATIC_CONFIG_SYNC_PLUGIN_STARTED') }
}
export default defineHostApplication(startup => {
 const facts = startup.deployment?.application;
 if (!facts) throw new Error('MISSING_STATIC_MANIFEST_FACTS');
 const tamper = startup.env.PLUXEL_STATIC_SYNC_TAMPER;
 const artifact = tamper === 'name'
  ? { ...facts, name: facts.name + '-different' }
  : tamper === 'catalogHash'
   ? { ...facts, catalogHash: '0'.repeat(64) }
   : facts;
 return {
  name: 'static-config-sync',
  plugins: [Probe],
  state: { initial: { autoStart: [pluginNodeAddressOf(Probe)] } },
  configSync: { role: 'writer', scope: 'static-fixture', identity: 'writer', artifact, replicas: [] },
  prepare({ host }) {
   runtime.__staticSyncHost = host;
   console.log('STATIC_CONFIG_SYNC_PREPARED');
  },
 };
});
`,
		)
		const buildScript = join(root, 'build.mts')
		await writeFile(
			buildScript,
			`
import { build } from ${JSON.stringify(import.meta.resolve('vite-plus/pack'))};
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
await build({ cwd: ${JSON.stringify(root)}, entry: 'app.ts', plugins: [pluxel({ delivery: 'standalone', variant: 'headless', launcher: 'host', lint: false })], config: false });
`,
		)
		await execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), buildScript], {
			timeout: 30000,
			maxBuffer: 4 * 1024 * 1024,
		})
		const manifest = JSON.parse(
			await readFile(join(root, 'dist/pluxel-deployment.json'), 'utf8'),
		) as { application: { name: string; catalogHash: string }; server: { runtimeClosure: string } }
		expect(manifest.application.name).toBe('static-config-sync')
		expect(manifest.application.catalogHash).toMatch(/^[a-f\d]{64}$/)
		expect(manifest.server.runtimeClosure).toBe('bundled')
		await rename(join(root, 'dist'), deployed)
		await rm(root, { recursive: true, force: true })
		const entry = pathToFileURL(join(deployed, 'app.mjs')).href
		const child = await execFileAsync(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
const app = await import(${JSON.stringify(entry)});
try {
 const host = globalThis.__staticSyncHost;
 assert.ok(host, 'Application preparation must receive the real Host');
 assert.equal(app.ctx, host.ctx);
 const config = host.config.status();
 assert.equal(config.readonly, false);
 assert.match(config.version.history, /^[a-f\\d-]{36}$/);
 assert.equal(config.version.seq, 0);
 const sync = host.configSync.status();
 assert.equal(sync.role, 'writer');
 assert.equal(sync.scope, 'static-fixture');
 assert.deepEqual(sync.artifact, ${JSON.stringify(manifest.application)});
 assert.deepEqual(sync.sourceVersion, config.version);
 assert.deepEqual(sync.savedVersion, config.version);
 console.log('STATIC_CONFIG_SYNC_VERIFIED');
} finally { await app.stop(); }
`,
			],
			{
				cwd: deployed,
				env: { ...process.env, PLUXEL_STATIC_SYNC_TAMPER: '' },
				timeout: 30000,
			},
		)
		expect(child.stdout).toContain('STATIC_CONFIG_SYNC_PREPARED')
		expect(child.stdout).toContain('STATIC_CONFIG_SYNC_PLUGIN_STARTED')
		expect(child.stdout).toContain('STATIC_CONFIG_SYNC_VERIFIED')
		for (const field of ['name', 'catalogHash']) {
			const rejected = await execFileAsync(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
import assert from 'node:assert/strict';
await assert.rejects(import(${JSON.stringify(entry)}), /Synchronization must match the deployed application artifact facts/);
assert.equal(globalThis.__staticSyncHost, undefined, 'Artifact rejection must precede preparation');
console.log('STATIC_CONFIG_SYNC_REJECTED');
`,
				],
				{
					cwd: deployed,
					env: { ...process.env, PLUXEL_STATIC_SYNC_TAMPER: field },
					timeout: 30000,
				},
			)
			expect(rejected.stdout).toContain('STATIC_CONFIG_SYNC_REJECTED')
			expect(rejected.stdout).not.toContain('STATIC_CONFIG_SYNC_PREPARED')
			expect(rejected.stdout).not.toContain('STATIC_CONFIG_SYNC_PLUGIN_STARTED')
		}
	} finally {
		await rm(temporary, { recursive: true, force: true })
	}
}, 60000)
