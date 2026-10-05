import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

const loader = new URL('../src/native-source-loader.ts', import.meta.url).href
const transport = new URL('../../workbench/src/workbench/shared-transport.ts', import.meta.url).href
const core = new URL('../../core/', import.meta.url).pathname
const hostPackage = new URL('../', import.meta.url).pathname
const tsx = new URL('../../rolldown/node_modules/tsx/dist/loader.mjs', import.meta.url).href

function fixture(installedVersion: string, markerVersion = '0.12.0') {
	const root = mkdtempSync(join(tmpdir(), 'pluxel-source-capnweb-'))
	const put = (path: string, value: string) => {
		const file = join(root, path)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, value)
	}
	const packageModule = (owner: string, version: string, marker?: string, peer?: string) => {
		put(
			`node_modules/${owner}/package.json`,
			JSON.stringify({
				name: owner,
				version: '1.0.0',
				type: 'module',
				exports: './index.mjs',
				...(marker ? { pluxel: { workbenchCapnweb: marker } } : {}),
				...(peer ? { peerDependencies: { capnweb: peer } } : {}),
			}),
		)
		put(
			`node_modules/${owner}/index.mjs`,
			`import { RpcTarget } from 'capnweb'; export { RpcTarget }`,
		)
		put(
			`node_modules/${owner}/node_modules/capnweb/package.json`,
			JSON.stringify({
				name: 'capnweb',
				version,
				type: 'module',
				exports: './index.mjs',
			}),
		)
		put(`node_modules/${owner}/node_modules/capnweb/index.mjs`, 'export class RpcTarget {}')
	}
	put(
		'node_modules/@pluxel/workbench/package.json',
		JSON.stringify({
			name: '@pluxel/workbench',
			type: 'module',
			version: '1.0.0',
			exports: { '.': './index.mjs', './internal/transport': './transport.mjs' },
		}),
	)
	put('node_modules/@pluxel/workbench/index.mjs', 'export {}')
	put(
		'node_modules/@pluxel/workbench/transport.mjs',
		`export { assertWorkbenchCapnwebAdmission, readWorkbenchCapnwebPackage } from ${JSON.stringify(transport)}`,
	)
	symlinkSync(core, join(root, 'node_modules/@pluxel/core'))
	symlinkSync(hostPackage, join(root, 'node_modules/@pluxel/host'))
	put('package.json', JSON.stringify({ name: 'source-probe', type: 'module' }))
	put(
		'host-capnweb/package.json',
		JSON.stringify({ name: 'capnweb', version: '0.12.0', type: 'module', exports: './index.mjs' }),
	)
	put('host-capnweb/index.mjs', 'export class RpcTarget {}')
	symlinkSync(join(root, 'host-capnweb'), join(root, 'node_modules/capnweb'))
	packageModule('target-plugin', installedVersion, markerVersion, '0.12.0')
	packageModule('shared-library', '0.12.0', undefined, '0.12.0')
	packageModule('private-rpc', '0.13.0')
	put(
		'entry.mjs',
		`import { BasePlugin, Plugin } from '@pluxel/core'; import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain';
class Fixture extends BasePlugin {}; Plugin()(Fixture); __setPluginDefinition(Fixture, { abiVersion: PLUGIN_LOWERING_ABI_VERSION, kind: 'plugin', definition: { entry: { kind: 'package-root', packageName: 'source-probe' }, exportName: 'Fixture' } }); export { Fixture };
export { RpcTarget as Target } from 'target-plugin'; export { RpcTarget as Base } from 'shared-library'; export { RpcTarget as Private } from 'private-rpc'`,
	)
	return root
}

it('bridges only marked Workbench publishers to the host module in a fresh process', () => {
	const root = fixture('0.12.0')
	try {
		const output = execFileSync(
			process.execPath,
			[
				'--import',
				tsx,
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict'
import { createNativeSourceLoader } from ${JSON.stringify(loader)}
const root = ${JSON.stringify(root)}
const source = await createNativeSourceLoader({ root, sharedPackages: ['@pluxel/workbench'] })
try {
 await source.load(root + '/entry.mjs')
 const module = await import('file://' + root + '/entry.mjs')
 const host = await import('file://' + root + '/host-capnweb/index.mjs')
 assert.equal(module.Target, host.RpcTarget)
 assert.equal(module.Base, host.RpcTarget)
 assert.notEqual(module.Private, host.RpcTarget)
 console.log('TARGET_SHARED_PRIVATE_INDEPENDENT')
} finally { source.close() }
`,
			],
			{ cwd: root, encoding: 'utf8' },
		)
		expect(output).toContain('TARGET_SHARED_PRIVATE_INDEPENDENT')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}, 30_000)

it('reports the publisher, installed version and host version before evaluating a mismatched target', () => {
	const root = fixture('0.13.0')
	try {
		const output = execFileSync(
			process.execPath,
			[
				'--import',
				tsx,
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict'
import { createNativeSourceLoader } from ${JSON.stringify(loader)}
const root = ${JSON.stringify(root)}
const source = await createNativeSourceLoader({ root, sharedPackages: ['@pluxel/workbench'] })
try {
 await assert.rejects(source.load(root + '/entry.mjs'), error => {
  assert.match(error.message, /target-plugin.*peerDependencies.capnweb 0\\.12\\.0.*resolved 0\\.13\\.0.*Host Workbench supports 0\\.12\\.0/)
  return true
 })
 console.log('MISMATCH_DIAGNOSED')
} finally { source.close() }
`,
			],
			{ cwd: root, encoding: 'utf8' },
		)
		expect(output).toContain('MISMATCH_DIAGNOSED')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}, 30_000)
