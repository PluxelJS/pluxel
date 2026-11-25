import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { hostPackage } from '../support/workspace'
import { assertWorkbenchApplicationRuntime } from '../../src/shared-runtime'

const loader = new URL('src/native-source-loader.ts', hostPackage).href
const core = fileURLToPath(new URL('../core/', hostPackage))
const tsx = new URL('../rolldown/node_modules/tsx/dist/loader.mjs', hostPackage).href
const { version: supported } = JSON.parse(
	readFileSync(new URL('node_modules/capnweb/package.json', hostPackage), 'utf8'),
) as { version: string }

it('checks the physical application entry owner even when the workspace provides a resolvable capnweb', () => {
	const root = mkdtempSync(join(tmpdir(), 'pluxel-application-capnweb-'))
	const member = join(root, 'apps/member')
	const entry = join(member, 'app.mjs')
	const manifest = join(member, 'package.json')
	try {
		mkdirSync(member, { recursive: true })
		mkdirSync(join(root, 'node_modules/@pluxel'), { recursive: true })
		symlinkSync(fileURLToPath(hostPackage), join(root, 'node_modules/@pluxel/host'))
		symlinkSync(
			fileURLToPath(new URL('node_modules/capnweb/', hostPackage)),
			join(root, 'node_modules/capnweb'),
		)
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ dependencies: { capnweb: supported } }),
		)
		writeFileSync(entry, '')
		const alias = join(root, 'link.mjs')
		symlinkSync(entry, alias)
		for (const declaration of [undefined, '^' + supported, '0.0.1']) {
			writeFileSync(
				manifest,
				JSON.stringify({ name: 'member', dependencies: { capnweb: declaration } }),
			)
			expect(() => assertWorkbenchApplicationRuntime(alias)).toThrow(manifest)
			expect(() => assertWorkbenchApplicationRuntime(alias)).toThrow(
				`dependencies.capnweb ${declaration ?? '<missing>'}`,
			)
		}
		writeFileSync(
			manifest,
			JSON.stringify({ name: 'member', dependencies: { capnweb: supported } }),
		)
		expect(assertWorkbenchApplicationRuntime(alias)).toBe(supported)
		const shadow = join(member, 'node_modules/capnweb')
		mkdirSync(shadow, { recursive: true })
		writeFileSync(
			join(shadow, 'package.json'),
			JSON.stringify({ name: 'capnweb', version: '0.0.1', exports: './index.mjs' }),
		)
		writeFileSync(join(shadow, 'index.mjs'), '')
		expect(() => assertWorkbenchApplicationRuntime(entry)).toThrow('resolved 0.0.1')
		const otherHost = join(member, 'node_modules/@pluxel/host')
		mkdirSync(otherHost, { recursive: true })
		const otherHostManifest = join(otherHost, 'package.json')
		writeFileSync(
			otherHostManifest,
			JSON.stringify({ name: '@pluxel/host', exports: { './package.json': './package.json' } }),
		)
		writeFileSync(manifest, JSON.stringify({ name: 'member', dependencies: { capnweb: '0.0.1' } }))
		expect(() => assertWorkbenchApplicationRuntime(entry)).toThrow(
			`Host capnweb supports ${supported}`,
		)
		expect(assertWorkbenchApplicationRuntime(entry, otherHostManifest)).toBe('0.0.1')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})

function fixture(installedVersion = supported) {
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
	mkdirSync(join(root, 'node_modules/@pluxel'), { recursive: true })
	symlinkSync(core, join(root, 'node_modules/@pluxel/core'))
	symlinkSync(fileURLToPath(hostPackage), join(root, 'node_modules/@pluxel/host'))
	put('package.json', JSON.stringify({ name: 'source-probe', type: 'module' }))
	packageModule('target-plugin', installedVersion, supported, supported)
	packageModule('shared-library', supported, undefined, supported)
	packageModule('private-rpc', '0.13.0')
	put(
		'entry.mjs',
		`import { BasePlugin, Plugin } from '@pluxel/core'; import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain';
class Fixture extends BasePlugin {}; Plugin()(Fixture); __setPluginDefinition(Fixture, { abiVersion: PLUGIN_LOWERING_ABI_VERSION, kind: 'plugin', definition: { entry: { kind: 'package-root', packageName: 'source-probe' }, exportName: 'Fixture' } }); export { Fixture };
export { RpcTarget as Target } from 'target-plugin'; export { RpcTarget as Base } from 'shared-library'; export { RpcTarget as Private } from 'private-rpc'`,
	)
	return root
}

it('bridges only declared publishers without Workbench to the host module in a fresh process', () => {
	const root = fixture()
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
const source = await createNativeSourceLoader({ root })
try {
 await source.load(root + '/entry.mjs')
 const module = await import('file://' + root + '/entry.mjs')
 const host = await import(${JSON.stringify(import.meta.resolve('capnweb'))})
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
const source = await createNativeSourceLoader({ root })
try {
 await assert.rejects(source.load(root + '/entry.mjs'), error => {
  assert.match(error.message, /target-plugin.*resolved 0\\.13\\.0/)
  assert.ok(error.message.includes('peerDependencies.capnweb ${supported}'))
  assert.ok(error.message.includes('Host capnweb supports ${supported}'))
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
