import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const repository = resolve(import.meta.dirname, '../../..')
const elysiaManifest = await realpath(
	resolve(repository, 'packages/services/node_modules/elysia/package.json'),
)
const peerRequire = createRequire(elysiaManifest)
const nodeManifest = await realpath(
	resolve(repository, 'packages/services/node_modules/@types/node/package.json'),
)
const bunManifest = peerRequire.resolve('@types/bun/package.json')
const directory = await mkdtemp(resolve(tmpdir(), 'pluxel-elysia-declarations-'))
try {
	await mkdir(resolve(directory, 'node_modules/@types'), { recursive: true })
	for (const [name, manifest] of [
		['elysia', elysiaManifest],
		['@types/node', nodeManifest],
		['@types/bun', bunManifest],
	])
		await symlink(dirname(manifest), resolve(directory, 'node_modules', name), 'dir')
	await writeFile(
		resolve(directory, 'package.json'),
		JSON.stringify({ private: true, type: 'module' }),
	)
	await writeFile(
		resolve(directory, 'consumer.ts'),
		"import { Elysia } from 'elysia'\nexport const app = new Elysia()\n",
	)
	await writeFile(
		resolve(directory, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				module: 'NodeNext',
				target: 'ESNext',
				types: ['node', 'bun'],
			},
			files: ['consumer.ts'],
		}),
	)
	console.log('Elysia', JSON.parse(await readFile(elysiaManifest, 'utf8')).version)
	const result = spawnSync(
		resolve(repository, 'node_modules/.bin/tsc'),
		['--project', resolve(directory, 'tsconfig.json'), '--pretty', 'false'],
		{ cwd: directory, encoding: 'utf8' },
	)
	if (result.error) throw result.error
	process.stdout.write(result.stdout)
	process.stderr.write(result.stderr)
	process.exitCode = result.status ?? 1
} finally {
	await rm(directory, { recursive: true, force: true })
}
