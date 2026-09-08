import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { it, onTestFinished } from 'vitest'

async function fixture(files = {}) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-source-declarations-'))
	onTestFinished(() => rm(root, { recursive: true, force: true }))
	await mkdir(join(root, 'scripts'))
	const script = join(root, 'scripts/check-source-declarations.mjs')
	await copyFile(new URL('./check-source-declarations.mjs', import.meta.url), script)
	for (const [path, content] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true })
		await writeFile(join(root, path), content)
	}
	return () => execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' })
}

it('accepts a clean checkout without build output or pre-existing declarations', async () => {
	const check = await fixture({
		'projects/docs/tsconfig.json': JSON.stringify({ compilerOptions: { types: ['vite/client'] } }),
		'packages/example/src/index.ts': 'export const value = 1\n',
	})
	assert.match(check(), /passed \(0 explicit declarations found\)/)
})

it('accepts registered ambient inputs and keeps build/cache output outside the source boundary', async () => {
	const check = await fixture({
		'projects/docs/src/styles.d.ts': "declare module '*.css'\n",
		'packages/example/dist/index.d.ts': 'export declare const value = 1\n',
		'packages/example/dist/index.d.ts.map': '{}',
		'packages/example/.pluxel/types/index.d.mts': 'export {}\n',
		'packages/example/node_modules/dependency/index.d.ts.map': '{}',
	})
	assert.match(check(), /passed \(1 explicit declarations found\)/)
})

it('rejects unregistered source declarations and leaked declaration maps in every module format', async () => {
	const unexpected = [
		'packages/example/src/index.d.ts',
		'plugins/example/src/index.d.mts',
		'projects/example/src/index.d.cts',
		'packages/example/index.d.ts.map',
		'plugins/example/src/index.d.mts.map',
		'projects/docs/src/styles.d.ts.map',
		'projects/example/index.d.cts.map',
		'projects/docs/src/vite-env.d.ts',
	].toSorted()
	const check = await fixture(Object.fromEntries(unexpected.map((path) => [path, ''])))
	assert.throws(check, (error) => {
		assert.equal(error.status, 1)
		assert.ok(error.stderr.includes(`\n- ${unexpected.join('\n- ')}\n`))
		assert.match(error.stderr, /register handwritten ambient declarations explicitly/)
		return true
	})
})
