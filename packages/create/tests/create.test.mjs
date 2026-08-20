import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it } from 'node:test'

const packageRoot = resolve(import.meta.dirname, '..')
const repositoryRoot = resolve(packageRoot, '../..')
const bin = resolve(packageRoot, 'dist/create.mjs')
let temporaryRoot

before(async () => {
	temporaryRoot = await mkdtemp(join(tmpdir(), 'create-pluxel-test-'))
})

after(async () => {
	await rm(temporaryRoot, { recursive: true, force: true })
})

describe('create-pluxel', () => {
	it('builds a typed single-file npm CLI boundary with tsdown', async () => {
		const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
		assert.deepEqual(manifest.bin, { 'create-pluxel': './dist/create.mjs' })
		assert.deepEqual(manifest.exports, { './package.json': './package.json' })
		assert.match(await readFile(bin, 'utf8'), /^#!\/usr\/bin\/env node\n/)
		assert.equal((await lstat(bin)).mode & 0o111, 0o111)
	})

	it('copies the fixed starter and the versioned documentation byte-for-byte', async () => {
		const result = await run([bin, 'starter', '--no-install'], temporaryRoot)
		assert.equal(result.code, 0, result.stderr)

		const generated = resolve(temporaryRoot, 'starter')
		assert.match(await readFile(resolve(generated, '.gitignore'), 'utf8'), /node_modules\//)
		const manifest = JSON.parse(await readFile(resolve(generated, 'package.json'), 'utf8'))
		assert.equal(manifest.name, undefined)
		assert.equal(manifest.private, true)
		await assert.rejects(readFile(resolve(generated, 'host/web/package.json')), { code: 'ENOENT' })
		assert.doesNotMatch(
			await readFile(resolve(generated, 'host/web/src/client/main.tsx'), 'utf8'),
			/from ['"](?:@pluxel\/|@example\/)/,
		)
		const hostManifest = JSON.parse(await readFile(resolve(generated, 'host/package.json'), 'utf8'))
		assert.deepEqual(
			Object.fromEntries(
				Object.entries(hostManifest.dependencies).filter(([name]) => name.startsWith('@example/')),
			),
			{
				'@example/audit-plugin': 'workspace:*',
				'@example/http-plugin': 'workspace:*',
				'@example/todo-plugin': 'workspace:*',
			},
		)
		assert.match(await readFile(resolve(generated, 'host/vite.config.ts'), 'utf8'), /root: webRoot/)
		await assert.rejects(readFile(resolve(generated, 'host/vite.dynamic.config.ts')), {
			code: 'ENOENT',
		})
		await assert.rejects(readFile(resolve(generated, 'host/web/vite.config.ts')), {
			code: 'ENOENT',
		})

		const sourceFiles = await listFiles(resolve(repositoryRoot, 'docs'))
		const generatedFiles = await listFiles(resolve(generated, 'docs/pluxel'))
		assert.deepEqual(generatedFiles, sourceFiles)
		for (const path of sourceFiles) {
			const [source, copied] = await Promise.all([
				readFile(resolve(repositoryRoot, 'docs', path)),
				readFile(resolve(generated, 'docs/pluxel', path)),
			])
			assert.deepEqual(copied, source, `documentation bytes differ: ${path}`)
		}
	})

	it('does not overwrite a non-empty destination', async () => {
		const result = await run([bin, 'starter', '--no-install'], temporaryRoot)
		assert.notEqual(result.code, 0)
		assert.match(result.stderr, /Destination is not empty/)
	})

	it('accepts an existing empty destination', async () => {
		await mkdir(resolve(temporaryRoot, 'empty'))
		const result = await run([bin, 'empty', '--no-install'], temporaryRoot)
		assert.equal(result.code, 0, result.stderr)
		assert.equal(
			JSON.parse(await readFile(resolve(temporaryRoot, 'empty/package.json'), 'utf8')).private,
			true,
		)
	})

	it('exposes help and package version without loading the CLI', async () => {
		const [help, version] = await Promise.all([
			run([bin, '--help'], temporaryRoot),
			run([bin, '--version'], temporaryRoot),
		])
		assert.equal(help.code, 0)
		assert.match(help.stdout, /fixed Pluxel example monorepo/)
		assert.equal(version.code, 0)
		assert.match(version.stdout, /^\d+\.\d+\.\d+\s*$/)
	})
})

async function listFiles(root, current = '') {
	const entries = await readdir(resolve(root, current), { withFileTypes: true })
	const files = []
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const path = current ? `${current}/${entry.name}` : entry.name
		if (entry.isDirectory()) files.push(...(await listFiles(root, path)))
		else if (entry.isFile()) files.push(path)
		else throw new Error(`Unexpected entry in test fixture: ${path}`)
	}
	return files
}

async function run(args, cwd) {
	return await new Promise((accept, reject) => {
		const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk))
		child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk))
		child.once('error', reject)
		child.once('exit', (code, signal) => accept({ code, signal, stdout, stderr }))
	})
}
