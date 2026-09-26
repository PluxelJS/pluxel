import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rolldown } from 'rolldown'
import { expect, it } from 'vitest'
import { staticWorkbenchCapnwebPlugin } from '../src/cli/static-workbench-capnweb'

async function fixture(installedVersion: string) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-static-capnweb-'))
	const put = async (path: string, value: string) => {
		const file = join(root, path)
		await mkdir(dirname(file), { recursive: true })
		await writeFile(file, value)
	}
	const capnweb = async (path: string, version: string) => {
		await put(
			`${path}/package.json`,
			JSON.stringify({ name: 'capnweb', version, type: 'module', exports: './index.mjs' }),
		)
		await put(`${path}/index.mjs`, 'export class RpcTarget {}')
	}
	await put('package.json', JSON.stringify({ name: 'app', type: 'module' }))
	await put(
		'node_modules/@pluxel/workbench/package.json',
		JSON.stringify({
			name: '@pluxel/workbench',
			type: 'module',
			exports: { './package.json': './package.json', './service': './service.mjs' },
		}),
	)
	await put('node_modules/@pluxel/workbench/service.mjs', "export { RpcTarget } from 'capnweb'")
	await capnweb('node_modules/@pluxel/workbench/node_modules/capnweb', '0.12.0')
	for (const [name, version, marked] of [
		['target-plugin', installedVersion, true],
		['private-rpc', '0.13.0', false],
	] as const) {
		await put(
			`node_modules/${name}/package.json`,
			JSON.stringify({
				name,
				type: 'module',
				exports: './index.mjs',
				...(marked ? { pluxel: { workbenchCapnweb: '0.12.0' } } : {}),
			}),
		)
		await put(`node_modules/${name}/index.mjs`, "export { RpcTarget } from 'capnweb'")
		await capnweb(`node_modules/${name}/node_modules/capnweb`, version)
	}
	await put(
		'app.mjs',
		[
			"import { RpcTarget as Host } from '@pluxel/workbench/service'",
			"import { RpcTarget as Target } from 'target-plugin'",
			"import { RpcTarget as Private } from 'private-rpc'",
			'export const targetShared = Target === Host',
			'export const privateIndependent = Private !== Host',
		].join('\n'),
	)
	return { root, entry: join(root, 'app.mjs') }
}

it('bundles a marked target with the Workbench constructor while preserving private RPC', async () => {
	const { root, entry } = await fixture('0.12.0')
	try {
		const bundle = await rolldown({ input: entry, plugins: [staticWorkbenchCapnwebPlugin(entry)] })
		await bundle.write({ file: join(root, 'bundle.mjs'), format: 'esm' })
		await bundle.close()
		const result = await import(pathToFileURL(join(root, 'bundle.mjs')).href)
		expect(result.targetShared).toBe(true)
		expect(result.privateIndependent).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('rejects a marked target whose installed version differs from Workbench', async () => {
	const { root, entry } = await fixture('0.13.0')
	try {
		const bundle = await rolldown({ input: entry, plugins: [staticWorkbenchCapnwebPlugin(entry)] })
		await expect(bundle.write({ file: join(root, 'bundle.mjs'), format: 'esm' })).rejects.toThrow(
			/target-plugin.*resolves capnweb 0\.13\.0; host Workbench supports 0\.12\.0/,
		)
		await bundle.close()
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
