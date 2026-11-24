import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { openProjectControl } from '../../../packages/host-vite/tests/script-control.fixture.mjs'

const require = createRequire(new URL('../../../packages/host-vite/package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
const { host } = await import(require.resolve('@pluxel/host-vite'))
const { controlHmr, runScript, syncPluginControl } = await import(
	require.resolve('@pluxel/agent-sdk/client')
)
const evidence = JSON.parse(await readFile(new URL('./observations.json', import.meta.url), 'utf8'))
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const materialOutput = process.argv[2]
const root = await mkdtemp(join(tmpdir(), 'pluxel-control-evaluation-'))
const target = { root }
const paths = ['standard', 'secondary', 'priority'].map((name) => 'entries/' + name + '.entry.ts')
let server
async function start() {
	await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
	for (const name of ['host', 'agent-sdk', 'core']) {
		await symlink(
			join(workspace, 'packages', name),
			join(root, 'node_modules/@pluxel', name),
			'dir',
		)
	}
	await symlink(
		join(workspace, 'packages/core/node_modules/valibot'),
		join(root, 'node_modules/valibot'),
		'dir',
	)
	await mkdir(join(root, 'entries'))
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ type: 'module', name: 'dispatch-evaluation' }),
	)
	await writeFile(
		join(root, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ESNext',
				module: 'ESNext',
				moduleResolution: 'Bundler',
				preserveSymlinks: true,
				strict: true,
				skipLibCheck: true,
				experimentalDecorators: true,
				allowImportingTsExtensions: true,
				noEmit: true,
				types: ['node'],
				typeRoots: [dirname(dirname(require.resolve('@types/node/package.json')))],
				lib: ['ESNext', 'DOM'],
			},
			include: ['*.ts', 'entries/*'],
		}),
	)
	const pluginNodes = paths.map((path) => ({
		definition: { entry: { kind: 'source-entry', sourceSpace: 'app', path }, exportName: 'Router' },
		autoStart: true,
	}))
	await writeFile(
		join(root, 'app.ts'),
		`import { defineHostApplication } from '@pluxel/host'
export default defineHostApplication(()=>({name:'Dispatch fixture',sources:[{directory:'./entries',include:['*.entry.ts']}], pluginNodes:${JSON.stringify(pluginNodes)}}))`,
	)
	await writeFile(
		join(root, 'policy.ts'),
		`import * as v from 'valibot'
export const DispatchPolicy = v.object({ shardBudget: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(12)), 7) })
`,
	)
	for (const [index, method] of ['queueSize', 'listRoutes'].entries()) {
		await writeFile(
			join(root, paths[index]),
			`import { BasePlugin, Plugin } from '@pluxel/core'
@Plugin() export class Router extends BasePlugin { ${method}(): number { return 3 } }`,
		)
	}
	server = await createServer({
		root,
		configFile: false,
		server: { host: '127.0.0.1', port: 0 },
		plugins: host({ entry: 'app.ts', scripts: true }),
		logLevel: 'error',
	})
	await server.listen()
}
async function admit(version) {
	const [id] = await readdir(join(root, '.pluxel/dev-console'))
	using client = await openProjectControl(
		JSON.parse(await readFile(join(root, '.pluxel/dev-console', id), 'utf8')),
	)
	const paused = await controlHmr({ target, action: 'pause' })
	assert.equal(paused.run.state, 'succeeded')
	const before = (await client.describe()).hmr.observedRevision
	await writeFile(
		join(root, paths[2]),
		`import { BasePlugin,Plugin } from '@pluxel/core'
import { DispatchPolicy } from '../policy.ts'
@Plugin()
export class Router extends BasePlugin {
 private readonly config=this.configs.use(DispatchPolicy)
 /** Estimate processing time for priority tickets. */
 ${version === 1 ? 'estimateDispatch' : 'estimateRoutedDispatch'}(input: { tickets: number; rate: number }): number { return input.tickets * input.rate + this.config.shardBudget ${version === 2 ? '+100' : ''} }
}`,
	)
	const deadline = Date.now() + 10000
	while ((await client.describe()).hmr.observedRevision <= before) {
		if (Date.now() >= deadline) throw Error('The Vite watcher did not observe the fixture update')
		await delay(25)
	}
	const applied = await controlHmr({ target, action: 'apply' })
	assert.equal(applied.run.state, 'succeeded', JSON.stringify(applied.run))
	const out = join(root, 'snapshot' + version)
	const result = await syncPluginControl({ target, out })
	assert.equal(result.definitions.length, 3)
	console.log('material', version, result.snapshot)
	if (materialOutput) {
		assert.equal(result.snapshot, evidence.materials[version - 1], 'Control material has changed')
		await cp(join(out, 'current'), join(materialOutput, String(version)), {
			recursive: true,
			dereference: true,
		})
	}
	return join(out, 'current')
}
async function submit(file, script, material) {
	await writeFile(join(root, file + '.ts'), script.replaceAll('./material/', material + '/'))
	const { run } = await runScript({ target, file: join(root, file + '.ts') })
	return run
}
async function score(task, material) {
	for (const observation of evidence.trials.filter((trial) => trial.task === task)) {
		const run = await submit(observation.arm + task, observation.answer.script, material)
		assert.equal(run.state, 'succeeded', JSON.stringify(run))
		assert.equal(run.value, task === 1 ? 19 : 119)
		console.log(observation.arm + task, run.state, run.value)
	}
}
try {
	if (materialOutput) await mkdir(materialOutput)
	await start()
	const first = await admit(1)
	await score(1, first)
	const second = await admit(2)
	const oldScript = evidence.trials.find(({ arm, task }) => arm === 'A' && task === 1).answer.script
	const rejected = await submit('old-control', oldScript, first)
	assert.equal(rejected.error?.code, 'control_contract_mismatch', JSON.stringify(rejected))
	await score(2, second)
	for (const trial of evidence.trials.filter((trial) => trial.task === 3)) {
		const answer = trial.answer
		assert.equal(answer.file, 'policy.ts')
		assert.deepEqual(
			[answer.symbol, answer.field, answer.default, answer.min, answer.max, answer.integer],
			['DispatchPolicy', 'shardBudget', 7, 2, 12, true],
		)
		console.log(trial.arm + trial.task, 'schema matched')
	}
} finally {
	try {
		await server?.close()
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}
