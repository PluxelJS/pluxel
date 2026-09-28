import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCompletions } from './lsp-probe.mjs'

const experiment = dirname(fileURLToPath(import.meta.url))
const repository = resolve(experiment, '../../..')
const compiler = resolve(repository, 'node_modules/typescript/bin/tsc')
const root = await mkdtemp(resolve(tmpdir(), 'pluxel-production-bindings-'))
try {
	// Package links preserve real public exports. There are no source paths or custom conditions.
	const dependencies = {
		'@pluxel/host': 'packages/host',
		'@pluxel/core': 'packages/core',
		valibot: 'packages/host/node_modules/valibot',
		'@standard-schema/spec': 'packages/core/node_modules/@standard-schema/spec',
		'@types/node': 'packages/host/node_modules/@types/node',
	}
	for (const [name, target] of Object.entries(dependencies)) {
		const location = resolve(root, 'node_modules', name)
		await mkdir(dirname(location), { recursive: true })
		await symlink(resolve(repository, target), location, 'dir')
	}
	await writeFile(resolve(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
	await writeFile(
		resolve(root, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					strict: true,
					skipLibCheck: false,
					target: 'ES2022',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					types: ['node'],
					noEmit: true,
				},
				files: ['consumer.ts'],
			},
			null,
			2,
		),
	)
	const filename = resolve(root, 'consumer.ts')
	await writeFile(filename, await readFile(resolve(experiment, 'production-consumer.ts'), 'utf8'))
	const result = spawnSync(
		process.execPath,
		[compiler, '-p', resolve(root, 'tsconfig.json'), '--listFiles', '--pretty', 'false'],
		{ cwd: root, encoding: 'utf8', timeout: 60000 },
	)
	if (result.error) throw result.error
	assert.equal(result.status, 0, result.stdout + result.stderr)
	const resolvedFiles = result.stdout.split('\n').filter((line) => line.startsWith('/'))
	for (const packageName of ['host', 'core']) {
		assert.ok(
			resolvedFiles.some((file) => file.includes(`/packages/${packageName}/dist/index.d.`)),
			JSON.stringify(resolvedFiles),
		)
		assert.ok(
			!resolvedFiles.some((file) => file.includes(`/packages/${packageName}/src/`)),
			JSON.stringify(resolvedFiles),
		)
	}
	const report = {
		version: spawnSync(process.execPath, [compiler, '--version'], {
			encoding: 'utf8',
		}).stdout.trim(),
		typecheck: 'passed (strict, skipLibCheck=false; 10 @ts-expect-error checks)',
		publicDeclarations: resolvedFiles.filter((file) =>
			/\/packages\/(host|core)\/dist\/index\.d\./.test(file),
		),
		lsp: await checkCompletions({
			compiler,
			root,
			filename,
			extraProbes:
				'\nfileBinding(ExamplePlugin, {vault:{schema:ExampleCredentials,paths:{ /* file-completion */ }}})\n',
			extraMarkers: [['file-completion', ['credentials']]],
		}),
	}
	console.log(JSON.stringify(report, null, 2))
} finally {
	await rm(root, { recursive: true, force: true })
}
