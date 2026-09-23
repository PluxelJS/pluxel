// Native built-package Vite fixture: the Host and Node artifacts need no Runtime assembly.
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { vitePreset } from '../dist/vite.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'pluxel-host-node-'))
const events = (globalThis.__hostNodeSmoke = [])
let server
const until = async (predicate) => {
	const deadline = Date.now() + 15000
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Node artifact timeout: ${JSON.stringify(events)}`)
		await delay(30)
	}
}
try {
	await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
	for (const name of ['core', 'host', 'services'])
		await symlink(
			join(workspace, 'packages', name),
			join(root, 'node_modules/@pluxel', name),
			'dir',
		)
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ name: 'node-host-fixture', type: 'module' }),
	)
	await writeFile(join(root, 'task.ts'), 'export const value = 1\n')
	const definition = {
		entry: { kind: 'package-root', packageName: 'node-host-fixture' },
		exportName: 'Consumer',
	}
	await writeFile(
		join(root, 'app.mjs'),
		`
 import { defineConfig } from '@pluxel/host';
 import { BasePlugin, Plugin } from '@pluxel/core';
 import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain';
 import { nodeModules, NodeModules, defineNodeModule } from '@pluxel/services/node';
 const task = defineNodeModule(import.meta.url, './task.ts');
 class Consumer extends BasePlugin {
  async init() {
   await this.ctx.require(NodeModules).use(task, async url => {
    const { value } = await import(/* @vite-ignore */ url.href);
    globalThis.__hostNodeSmoke.push(value);
    return () => { globalThis.__hostNodeSmoke.push(-value) };
   }).catch(error => { globalThis.__hostNodeSmoke.push(String(error)); throw error });
  }
 }
 Plugin()(Consumer);
 __setPluginDefinition(Consumer, { abiVersion: PLUGIN_LOWERING_ABI_VERSION, kind: 'plugin', definition: ${JSON.stringify(definition)} });
 export default defineConfig(() => ({ plugins: [Consumer], services: [nodeModules()], state: { initial: { autoStart: [{ definition: ${JSON.stringify(definition)}, variant: 'default' }] } } }));
 `,
	)
	server = await createServer({
		root,
		configFile: false,
		logLevel: 'silent',
		server: { port: 0, host: '127.0.0.1' },
		plugins: [vitePreset({ entry: 'app.mjs' })],
	})
	await server.listen()
	await until(() => events.includes(1))
	// Let the initial watcher finish admission, then use the actual disk event path.
	await delay(150)
	await writeFile(join(root, 'task.ts'), 'export const value = 2\n')
	await until(() => events.includes(2))
	assert.deepEqual(events, [1, 2, -1])
	await delay(150)
	await writeFile(join(root, 'task.ts'), 'export const value = ;\n')
	await delay(500)
	assert.deepEqual(events, [1, 2, -1], 'invalid candidate retains last good setup')
	await writeFile(join(root, 'task.ts'), 'export const value = 3\n')
	await until(() => events.includes(3))
	await server.close()
	server = undefined
	assert.deepEqual(events, [1, 2, -1, 3, -2, -3])
	await writeFile(join(root, 'task.ts'), 'export const value = 4\n')
	await delay(180)
	assert.equal(events.includes(4), false, 'close ends watcher admission')
	console.log('INSTALLED_NODE_ARTIFACT_SMOKE_OK')
} finally {
	await server?.close()
	await rm(root, { recursive: true, force: true })
	delete globalThis.__hostNodeSmoke
}
