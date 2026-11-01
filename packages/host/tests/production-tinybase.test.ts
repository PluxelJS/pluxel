import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { hostSharedPackages } from '../src/shared-packages'

const loader = new URL('../src/native-source-loader.ts', import.meta.url).href
const coreTinybase = new URL('../../core/node_modules/tinybase/index.js', import.meta.url).href
const tsx = new URL('../../rolldown/node_modules/tsx/dist/loader.mjs', import.meta.url).href

it.each(['tinybase', 'capnweb'])(
	'rejects global %s sharing that would bypass capability ownership and rewrite private dependencies',
	(name) => {
		expect(() => hostSharedPackages({ root: tmpdir(), packages: [name] })).toThrow(
			'capability-scoped exact-version admission',
		)
	},
)

function fixture(
	installed = '10.0.1',
	peer: string | undefined = '10.0.1',
	hostDependency = '10.0.1',
) {
	const root = mkdtempSync(join(tmpdir(), 'pluxel-source-tinybase-'))
	const put = (path: string, value: unknown) => {
		const file = join(root, path)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
	}
	const tinybase = (path: string, version: string) => {
		put(`${path}/package.json`, {
			name: 'tinybase',
			version,
			type: 'module',
			exports: { '.': { import: './store.mjs' }, './queries': { import: './queries.mjs' } },
		})
		put(`${path}/store.mjs`, 'export const createStore = () => ({})')
		put(`${path}/queries.mjs`, 'export const createQueries = () => ({})')
	}
	put('package.json', {
		name: 'application',
		version: '1.0.0',
		type: 'module',
		dependencies: { tinybase: hostDependency },
	})
	mkdirSync(join(root, 'node_modules/@pluxel'), { recursive: true })
	symlinkSync(
		fileURLToPath(new URL('../../core', import.meta.url)),
		join(root, 'node_modules/@pluxel/core'),
		'dir',
	)
	tinybase('node_modules/tinybase', '10.0.1')
	for (const [name, version, shared] of [
		['consumer', installed, true],
		['library', '10.0.1', true],
		['private-store', '9.9.0', false],
	] as const) {
		put(`node_modules/${name}/package.json`, {
			name,
			version: '1.0.0',
			type: 'module',
			exports: './index.mjs',
			...(shared
				? {
						peerDependencies: peer ? { tinybase: peer } : {},
						...(name === 'consumer' ? { pluxel: { tinybase: '10.0.1' } } : {}),
					}
				: { dependencies: { tinybase: version } }),
		})
		put(
			`node_modules/${name}/index.mjs`,
			"export { createStore } from 'tinybase'; export { createQueries } from 'tinybase/queries'",
		)
		tinybase(`node_modules/${name}/node_modules/tinybase`, version)
	}
	put(
		'entry.mjs',
		`
import * as Consumer from 'consumer'
import * as Library from 'library'
import * as Private from 'private-store'
import { createStore as ApplicationStore } from 'tinybase'
export default () => ({
 shared: Consumer.createStore === Library.createStore,
 appPrivate: ApplicationStore !== Consumer.createStore,
 coreFactory: Consumer.createStore,
 subpaths: Consumer.createQueries === Library.createQueries,
 privateIndependent: Private.createStore !== Consumer.createStore && Private.createQueries !== Consumer.createQueries,
})
`,
	)
	return root
}

function run(root: string, script: string) {
	return execFileSync(
		process.execPath,
		[
			'--import',
			tsx,
			'--input-type=module',
			'-e',
			`
import assert from 'node:assert/strict'
import { createNativeSourceLoader } from ${JSON.stringify(loader)}
import { createStore as coreCreateStore } from ${JSON.stringify(coreTinybase)}
const root = ${JSON.stringify(root)}
const source = await createNativeSourceLoader({ root })
try { ${script} } finally { source.close() }
`,
		],
		{ cwd: root, encoding: 'utf8' },
	)
}

it('binds managed consumers and peer libraries to Core while preserving upstream subpaths and private application dependencies', () => {
	const root = fixture()
	try {
		const output = run(
			root,
			`const app = await source.loadApplication(root + '/entry.mjs'); const {coreFactory, ...facts} = app(); assert.equal(coreFactory, coreCreateStore); assert.deepEqual(facts, { shared: true, subpaths: true, privateIndependent: true, appPrivate: true }); console.log('TINYBASE_BOUND')`,
		)
		expect(output).toContain('TINYBASE_BOUND')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}, 30_000)

it('interoperates with real independently installed upstream Store and Queries modules through native loading', () => {
	const root = fixture()
	try {
		const upstream = new URL('../../core/node_modules/tinybase/', import.meta.url)
		expect(JSON.parse(readFileSync(new URL('package.json', upstream), 'utf8')).version).toBe(
			'10.0.1',
		)
		for (const path of [
			'node_modules/tinybase',
			'node_modules/consumer/node_modules/tinybase',
			'node_modules/library/node_modules/tinybase',
		]) {
			writeFileSync(join(root, path, 'store.mjs'), readFileSync(new URL('index.js', upstream)))
			writeFileSync(
				join(root, path, 'queries.mjs'),
				readFileSync(new URL('queries/index.js', upstream)),
			)
		}
		writeFileSync(
			join(root, 'entry.mjs'),
			`
import { createStore } from 'consumer'
import { createQueries } from 'library'
export default () => {
 const store = createStore().setRow('items', 'one', { name: 'Ada' })
 const queries = createQueries(store).setQueryDefinition('names', 'items', ({ select }) => select('name'))
 const result = queries.getResultTable('names')
 queries.destroy()
 return { createStore, result }
}
`,
		)
		const output = run(
			root,
			`const app = await source.loadApplication(root + '/entry.mjs'); const value = app(); assert.equal(value.createStore, coreCreateStore); assert.equal(value.result.one.name, 'Ada'); assert.equal(Object.getPrototypeOf(value.result), null); assert.equal(Object.getPrototypeOf(value.result.one), null); console.log('NATIVE_UPSTREAM_INTEROP')`,
		)
		expect(output).toContain('NATIVE_UPSTREAM_INTEROP')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}, 30_000)

it.each([
	['10.1.0', '10.0.1', '10.0.1', /consumer.*resolved 10\.1\.0.*Host Core supports 10\.0\.1/],
	['10.0.1', undefined, '10.0.1', /consumer.*peerDependencies.tinybase <missing>/],
] as const)(
	'rejects unsupported native shared TinyBase declarations or installations (%s, %s, %s)',
	(version, peer, hostDependency, diagnostic) => {
		const root = fixture(version, peer, hostDependency)
		// An absent peer must remain absent rather than taking the fixture's default.
		if (peer === undefined) {
			const file = join(root, 'node_modules/consumer/package.json')
			writeFileSync(
				file,
				JSON.stringify({
					name: 'consumer',
					version: '1.0.0',
					type: 'module',
					exports: './index.mjs',
					pluxel: { tinybase: '10.0.1' },
				}),
			)
		}
		try {
			const output = run(
				root,
				`await assert.rejects(source.loadApplication(root + '/entry.mjs'), error => { assert.match(error.message, ${diagnostic.toString()}); return true }); console.log('REJECTED')`,
			)
			expect(output).toContain('REJECTED')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	},
	30_000,
)

it('loads a Core-only plugin application without a direct TinyBase dependency', () => {
	const root = fixture()
	try {
		writeFileSync(
			join(root, 'package.json'),
			JSON.stringify({ name: 'application', version: '1.0.0', type: 'module' }),
		)
		writeFileSync(
			join(root, 'entry.mjs'),
			"import {BasePlugin} from '@pluxel/core'; export default () => ({fixedCore:typeof BasePlugin === 'function'})",
		)
		const output = run(
			root,
			`const app = await source.loadApplication(root + '/entry.mjs'); assert.deepEqual(app(), {fixedCore:true}); console.log('CORE_ONLY')`,
		)
		expect(output).toContain('CORE_ONLY')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
}, 30_000)
