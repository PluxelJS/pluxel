import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'

const loader = new URL('../src/production-source-loader.ts', import.meta.url).href
const tsx = new URL('../../rolldown/node_modules/tsx/dist/loader.mjs', import.meta.url).href

function fixture(installedVersion: string, markerVersion = '0.12.0') {
	const root = mkdtempSync(join(tmpdir(), 'pluxel-source-capnweb-'))
	const put = (path: string, value: string) => {
		const file = join(root, path)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, value)
	}
	const packageModule = (owner: string, version: string, marker?: string) => {
		put(
			`node_modules/${owner}/package.json`,
			JSON.stringify({
				name: owner,
				version: '1.0.0',
				type: 'module',
				exports: './index.mjs',
				...(marker ? { pluxel: { workbenchCapnweb: marker } } : {}),
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
	put('package.json', JSON.stringify({ name: 'source-probe', type: 'module' }))
	put(
		'host-capnweb/package.json',
		JSON.stringify({ name: 'capnweb', version: '0.12.0', type: 'module', exports: './index.mjs' }),
	)
	put('host-capnweb/index.mjs', 'export class RpcTarget {}')
	packageModule('target-plugin', installedVersion, markerVersion)
	packageModule('private-rpc', '0.13.0')
	put(
		'entry.mjs',
		"export { RpcTarget as Target } from 'target-plugin'; export { RpcTarget as Private } from 'private-rpc'",
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
import { createProductionSourceLoader } from ${JSON.stringify(loader)}
const root = ${JSON.stringify(root)}
const source = createProductionSourceLoader({ capnweb: new URL('./host-capnweb/index.mjs', 'file://' + root + '/').href }, '0.12.0')
try {
 const module = await source.load(root + '/entry.mjs')
 const host = await import('file://' + root + '/host-capnweb/index.mjs')
 assert.equal(module.Target, host.RpcTarget)
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
})

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
import { createProductionSourceLoader } from ${JSON.stringify(loader)}
const root = ${JSON.stringify(root)}
const source = createProductionSourceLoader({ capnweb: new URL('./host-capnweb/index.mjs', 'file://' + root + '/').href }, '0.12.0')
try {
 await assert.rejects(source.load(root + '/entry.mjs'), error => {
  assert.equal(error.code, 'PLUGIN_SOURCE_WORKBENCH_CAPNWEB_MISMATCH')
  assert.match(error.message, /target-plugin declares capnweb 0\\.12\\.0, resolves 0\\.13\\.0; host Workbench supports 0\\.12\\.0/)
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
})
