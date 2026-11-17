import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { rolldown } from 'rolldown'
import { expect, it } from 'vitest'
import { staticElysiaSingletonPlugin } from '../src/cli/elysia-singleton'

async function put(root: string, path: string, source: string) {
	const file = join(root, path)
	await mkdir(dirname(file), { recursive: true })
	await writeFile(file, source)
}

it('does not resolve or bundle HTTP for an application without Elysia imports', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-no-http-wiring-'))
	try {
		await put(root, 'app.mjs', 'console.log("NO_HTTP_OK")')
		const bundle = await rolldown({
			input: join(root, 'app.mjs'),
			plugins: [
				{
					name: 'reject-unselected-http',
					resolveId(id) {
						if (id.includes('@pluxel/services') || id.startsWith('elysia'))
							throw new Error(`Unselected HTTP resolved: ${id}`)
					},
				},
				staticElysiaSingletonPlugin(root),
			],
		})
		try {
			await bundle.write({ file: join(root, 'out.mjs'), format: 'esm' })
		} finally {
			await bundle.close()
		}
		const result = await promisify(execFile)(process.execPath, [join(root, 'out.mjs')])
		expect(result.stdout).toContain('NO_HTTP_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('wires actual Elysia schemas before module evaluation and preserves public exports after relocation', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-elysia-wiring-'))
	const source = join(root, 'source')
	try {
		await mkdir(join(source, 'node_modules/@pluxel'), { recursive: true })
		await symlink(
			fileURLToPath(new URL('../../services', import.meta.url)),
			join(source, 'node_modules/@pluxel/services'),
			'dir',
		)
		// A consumer's separate physical installation must not create a second identity.
		for (const name of ['elysia', 'exact-mirror']) {
			await put(
				source,
				`node_modules/${name}/package.json`,
				JSON.stringify({
					name,
					version: '0.0.0-fixture',
					type: 'module',
					exports: { '.': './index.mjs', './*': './index.mjs', './package.json': './package.json' },
				}),
			)
			await put(source, `node_modules/${name}/index.mjs`, 'throw new Error("SECOND_RUNTIME")')
		}
		const servicesRequire = createRequire(new URL('../../services/package.json', import.meta.url))
		const elysiaRequire = createRequire(servicesRequire.resolve('elysia/package.json'))
		await cp(
			dirname(dirname(elysiaRequire.resolve('typebox'))),
			join(source, 'node_modules/typebox'),
			{
				recursive: true,
			},
		)
		await put(source, 'package.json', JSON.stringify({ type: 'module' }))
		await put(
			source,
			'schema.mjs',
			`
import { t } from 'elysia'
export const schema = t.Object({ value: t.String({ format: 'pluxel-test' }) })
`,
		)
		await put(
			source,
			'app.mjs',
			`
import assert from 'node:assert/strict'
import { schema } from './schema.mjs'
import Type from 'typebox'
import { Literal } from 'typebox/type'
import { Format } from 'typebox/format'
import mirrorPackage from 'exact-mirror/package.json' with { type: 'json' }
import * as types from 'elysia/type'
import Elysia, { Elysia as NamedElysia } from 'elysia'
import { WebStandardAdapter } from 'elysia/adapter/web-standard'
assert.equal(types.Literal, Literal)
assert.equal('default' in types, false)
assert.equal(Elysia, NamedElysia)
assert.equal(Type.Literal, Literal)
assert.notEqual(mirrorPackage.version, '0.0.0-fixture')
Format.Set('pluxel-test', (value) => value === 'ready')
const app = new Elysia({ adapter: WebStandardAdapter }).post('/document', { body: schema, response: schema }, ({ body }) => body)
const response = await app.fetch(new Request('http://app.test/document', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'ready' }) }))
assert.equal(response.status, 200)
assert.deepEqual(await response.json(), { value: 'ready' })
const invalid = await app.fetch(new Request('http://app.test/document', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 42 }) }))
assert.equal(invalid.status, 422)
const invalidFormat = await app.fetch(new Request('http://app.test/document', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'wrong' }) }))
assert.equal(invalidFormat.status, 422)
console.log('RELOCATED_ELYSIA_SCHEMA_OK')
`,
		)
		const bundle = await rolldown({
			input: join(source, 'app.mjs'),
			platform: 'node',
			plugins: [staticElysiaSingletonPlugin(source)],
		})
		try {
			await bundle.write({ dir: join(source, 'dist'), format: 'esm', entryFileNames: 'app.mjs' })
		} finally {
			await bundle.close()
		}
		await rename(join(source, 'dist'), join(root, 'delivery'))
		await rm(source, { recursive: true, force: true })
		const result = await promisify(execFile)(process.execPath, [join(root, 'delivery/app.mjs')], {
			timeout: 10000,
			maxBuffer: 1024 * 1024,
		})
		expect(result.stdout).toContain('RELOCATED_ELYSIA_SCHEMA_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30000)
