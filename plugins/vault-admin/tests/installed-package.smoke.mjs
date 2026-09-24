import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
	cpSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const pluginRoot = resolve(import.meta.dirname, '..')
const workspace = resolve(pluginRoot, '../..')
const root = mkdtempSync(join(tmpdir(), 'pluxel-installed-workbench-target-'))

function run(command, args, cwd) {
	return execFileSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	})
}

try {
	run('pnpm', ['run', 'build'], pluginRoot)
	const packed = JSON.parse(run('pnpm', ['pack', '--json', '--pack-destination', root], pluginRoot))
	const nodeModules = join(root, 'node_modules')
	mkdirSync(join(nodeModules, '@pluxel'), { recursive: true })
	for (const name of ['core', 'services', 'test', 'workbench']) {
		symlinkSync(join(workspace, 'packages', name), join(nodeModules, '@pluxel', name), 'dir')
	}
	symlinkSync(
		join(workspace, 'packages/workbench/node_modules/capnweb'),
		join(nodeModules, 'capnweb'),
		'dir',
	)
	symlinkSync(join(workspace, 'packages/workbench/node_modules/ws'), join(nodeModules, 'ws'), 'dir')
	const plugin = join(nodeModules, '@pluxel/vault-admin')
	mkdirSync(plugin, { recursive: true })
	run('tar', ['-xzf', packed.filename, '-C', plugin, '--strip-components=1'], root)
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({ name: 'installed-probe', type: 'module' }),
	)
	writeFileSync(
		join(root, 'probe.mjs'),
		`
import assert from 'node:assert/strict'
import { createTestHost } from '@pluxel/test'
import { standardServices } from '@pluxel/services'
import { vault } from '@pluxel/services/vault'
import { VaultAdminPlugin } from '@pluxel/vault-admin'
import { VaultWorkbench } from '@pluxel/vault-admin/workbench'
import { WorkbenchHost } from '@pluxel/workbench/server'
import { pluginNodeAddressOf } from '@pluxel/core'
import { newWebSocketRpcSession } from 'capnweb'
import { WebSocketServer } from 'ws'
import { once } from 'node:events'

await using host = await createTestHost({
  workbench: true,
  services: [...standardServices({ persistence: { mode: 'memory' } }), vault()],
})
await host.start(VaultAdminPlugin)
using opened = await host.workbench.open({
  target: VaultAdminPlugin,
  entry: VaultWorkbench.overview,
  principal: { provider: 'installed-probe', subject: 'reader' },
  location: '/vault',
})
assert.ok(opened.api)
const backend = host.require(VaultAdminPlugin).ctx.root.require(WorkbenchHost)
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
await once(server, 'listening')
server.on('connection', socket => {
  const session = backend.createSession({ provider: 'installed-probe', subject: 'socket-reader' }, () => socket.close())
  const rpc = newWebSocketRpcSession(socket, session.target)
  socket.once('close', () => { rpc[Symbol.dispose](); session.dispose() })
})
const socket = new WebSocket('ws://127.0.0.1:' + server.address().port)
const remote = newWebSocketRpcSession(socket)
try {
  const target = pluginNodeAddressOf(VaultAdminPlugin)
  const layout = await remote.layoutDto({ target })
  assert.ok(layout.entries.length > 0)
  const result = await remote.openEntry({
    layoutRevision: layout.revision,
    target,
    descriptor: layout.entries[0].descriptor,
    location: '/vault',
  })
  assert.equal(result.ok, true)
  assert.equal(result.value.kind, 'local')
  result.value.api[Symbol.dispose]()
} finally {
  remote[Symbol.dispose]()
  for (const client of server.clients) client.terminate()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
`,
	)
	run(process.execPath, ['probe.mjs'], root)
	const packagedManifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
	assert.equal(packagedManifest.peerDependencies.capnweb, '0.12.0')
	assert.equal(packagedManifest.pluxel.workbenchCapnweb, '0.12.0')
	assert.equal(packagedManifest.dependencies?.capnweb, undefined)
	mkdirSync(join(plugin, 'node_modules'), { recursive: true })
	cpSync(
		join(workspace, 'packages/workbench/node_modules/capnweb'),
		join(plugin, 'node_modules/capnweb'),
		{ recursive: true, dereference: true },
	)
	const duplicate = spawnSync(process.execPath, ['probe.mjs'], { cwd: root, encoding: 'utf8' })
	assert.notEqual(duplicate.status, 0, 'an equal-version private copy must fail identity admission')
	assert.match(duplicate.stderr, /factory_failed|fresh RpcTarget/)
	console.log(
		'Installed Workbench target opened locally and over WebSocket; equal-version duplicate was rejected',
	)
} finally {
	rmSync(root, { recursive: true, force: true })
}
