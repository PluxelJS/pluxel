import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { it, onTestFinished } from 'vitest'

const exec = promisify(execFile)
const vp = fileURLToPath(new URL('../node_modules/vite-plus/bin/vp', import.meta.url))

async function fixture(tasks, build) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-task-cache-'))
	onTestFinished(() => rm(root, { recursive: true, force: true }))
	await mkdir(join(root, 'node_modules'))
	await symlink(
		fileURLToPath(new URL('../node_modules/vite-plus', import.meta.url)),
		join(root, 'node_modules/vite-plus'),
		'junction',
	)
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ name: 'cache-fixture', type: 'module' }),
	)
	await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
	await writeFile(
		join(root, 'vite.config.ts'),
		`import { repositoryTasks } from ${JSON.stringify(fileURLToPath(new URL('./vite-tasks.ts', import.meta.url)))};
export default { run: { tasks: repositoryTasks(${JSON.stringify(tasks)}) } };`,
	)
	await writeFile(join(root, 'build.mjs'), build)
	return {
		root,
		async run(task = 'compile') {
			const started = performance.now()
			try {
				const { stdout } = await exec(process.execPath, [vp, 'run', '-v', task], {
					cwd: root,
					timeout: 30_000,
				})
				return stdout
			} catch (error) {
				throw new Error(
					`Task fixture ${task} in ${root} failed after ${Math.round(performance.now() - started)}ms ` +
						`(code=${error.code}, signal=${error.signal}, killed=${error.killed}).\n` +
						`stdout:\n${error.stdout ?? ''}\nstderr:\n${error.stderr ?? ''}`,
					{ cause: error },
				)
			}
		},
	}
}

it('restores missing build output while tracking source and dependency artifacts', async () => {
	const { root, run } = await fixture(
		{ compile: 'node build.mjs' },
		`import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
await writeFile('dist/output.txt', await readFile('input.txt', 'utf8') + await readFile('dependency/dist/value.txt', 'utf8'));`,
	)
	await mkdir(join(root, 'dependency/dist'), { recursive: true })
	await writeFile(join(root, 'input.txt'), 'source one;')
	await writeFile(join(root, 'dependency/dist/value.txt'), 'dependency one')
	await run()
	await rm(join(root, 'dist'), { recursive: true })
	assert.match(await run(), /1 cache hit/)
	assert.equal(await readFile(join(root, 'dist/output.txt'), 'utf8'), 'source one;dependency one')

	await writeFile(join(root, 'input.txt'), 'source two;')
	assert.match(await run(), /1 cache miss/)
	assert.equal(await readFile(join(root, 'dist/output.txt'), 'utf8'), 'source two;dependency one')
	await writeFile(join(root, 'dependency/dist/value.txt'), 'dependency two')
	assert.match(await run(), /1 cache miss/)
	assert.equal(await readFile(join(root, 'dist/output.txt'), 'utf8'), 'source two;dependency two')
}, 60_000)

it('uses overridden outputs and keeps earlier build stages as inputs', async () => {
	const { root, run } = await fixture(
		{
			compile: {
				command: 'node build.mjs',
				cache: { output: [{ pattern: 'public/**', base: 'workspace' }] },
			},
		},
		`import { readFile, rm, mkdir, writeFile } from 'node:fs/promises';
await rm('public', { recursive: true, force: true });
await mkdir('public');
await writeFile('public/output.txt', await readFile('dist/input.txt'));`,
	)
	await mkdir(join(root, 'dist'))
	await writeFile(join(root, 'dist/input.txt'), 'first stage')
	await run()
	await rm(join(root, 'public'), { recursive: true })
	assert.match(await run(), /1 cache hit/)
	assert.equal(await readFile(join(root, 'public/output.txt'), 'utf8'), 'first stage')
	await writeFile(join(root, 'dist/input.txt'), 'updated stage')
	assert.match(await run(), /1 cache miss/)
	assert.equal(await readFile(join(root, 'public/output.txt'), 'utf8'), 'updated stage')
}, 60_000)

it('tracks explicit inputs retained inside an output directory', async () => {
	const { root, run } = await fixture(
		{
			compile: {
				command: 'node build.mjs',
				cache: { output: ['dist/**', '!dist/input.txt'], input: ['dist/input.txt'] },
			},
		},
		`import { readFile, writeFile } from 'node:fs/promises';
await writeFile('dist/output.txt', await readFile('dist/input.txt'));`,
	)
	await mkdir(join(root, 'dist'))
	await writeFile(join(root, 'dist/input.txt'), 'first input')
	await run()
	await rm(join(root, 'dist/output.txt'))
	assert.match(await run(), /1 cache hit/)
	assert.equal(await readFile(join(root, 'dist/output.txt'), 'utf8'), 'first input')
	await writeFile(join(root, 'dist/input.txt'), 'updated input')
	assert.match(await run(), /1 cache miss/)
	assert.equal(await readFile(join(root, 'dist/output.txt'), 'utf8'), 'updated input')
}, 60_000)
