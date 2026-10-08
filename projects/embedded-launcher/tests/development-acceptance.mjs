// Runs against an existing real Vite/Wayland application. No test Host is created.
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const repository = resolve(root, '../..')
const [native, profile, instance] = process.argv.slice(2)
if (!native || !profile || !instance)
	throw new Error('Usage: node tests/development-acceptance.mjs NATIVE PROFILE DISCOVERED_INSTANCE')
const evidence = []
function execute(command, args) {
	return new Promise((accept, reject) => {
		const child = spawn(command, args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
		let stdout = '',
			stderr = ''
		child.stdout.on('data', (value) => {
			stdout += value
		})
		child.stderr.on('data', (value) => {
			stderr += value
		})
		child.once('error', reject)
		child.once('close', (code) => {
			try {
				accept({ code, value: JSON.parse(stdout), stderr })
			} catch (cause) {
				reject(new Error(`Invalid receiver output: ${stdout}\n${stderr}`, { cause }))
			}
		})
	})
}
async function rpc(method, params = {}) {
	const response = await execute(native, [
		'cli',
		'--profile',
		profile,
		'--method',
		method,
		'--params',
		JSON.stringify(params),
	])
	assert.equal(response.code, 0, JSON.stringify(response))
	return response.value
}
async function ui(action) {
	return rpc('ui.control', { action })
}
async function settled(predicate, label) {
	const deadline = Date.now() + 15000
	let snapshot
	while (Date.now() < deadline) {
		snapshot = await ui({ type: 'inspect' })
		if (predicate(snapshot.state)) return snapshot.state
		await new Promise((accept) => setTimeout(accept, 50))
	}
	throw new Error(`${label} did not settle: ${JSON.stringify(snapshot)}`)
}
async function dev(exportName, input) {
	const args = [
		'packages/cli/bin/pluxel.mjs',
		'dev',
		'run',
		resolve(root, 'dev/inspect.ts'),
		'--root',
		root,
		'--instance',
		instance,
		'--export',
		exportName,
	]
	if (input !== undefined) args.push('--input', JSON.stringify(input))
	const response = await execute(process.execPath, args)
	assert.equal(response.value.ok, true, JSON.stringify(response))
	return response.value.value
}
const helper = resolve(root, 'src/plugins/calculator-label.ts')
const plugin = resolve(root, 'src/plugins/calculator-launcher.ts')
const originalHelper = await readFile(helper, 'utf8')
const originalPlugin = await readFile(plugin, 'utf8')
try {
	await ui({ type: 'input', text: '1/3' })
	const before = await settled(
		(state) => !state.loading && state.results.some((result) => result.title.startsWith('0.333')),
		'initial query',
	)
	const controlBefore = await dev('default')
	const oldHandle = before.results[0].handle
	const start = performance.now()
	await writeFile(
		helper,
		originalHelper.replace('计算 ${expression}', 'HMR 接收端验证 ${expression}'),
	)
	const updated = await settled(
		(state) =>
			!state.loading && state.results.some((result) => result.subtitle.includes('HMR 接收端验证')),
		'helper HMR native projection',
	)
	const controlAfter = await dev('default')
	assert.equal(controlBefore.hostEpoch, controlAfter.hostEpoch)
	assert.equal(controlAfter.value.update.outcome, 'applied')
	const relevant = controlAfter.value.plugins.find(
		(item) => item.rootExportName === 'CalculatorLauncher',
	)
	assert.equal(relevant.recentUpdate.batch.scope, 'definitions')
	const oldAction = await dev('action', oldHandle)
	assert.equal(oldAction.state, 'failed')
	assert.match(oldAction.error.message, /revoked/)
	evidence.push({
		case: 'helper-hmr-native-projection',
		elapsedMs: performance.now() - start,
		before,
		updated,
		controlAfter,
		oldAction,
	})
	await ui({ type: 'activate' })
	const copied = await settled(
		(state) => !state.busy && /Action completed/.test(state.notice),
		'clipboard receipt',
	)
	const clipboard = await new Promise((accept, reject) => {
		const child = spawn('wl-paste', ['--no-newline'], { stdio: ['ignore', 'pipe', 'pipe'] })
		let text = ''
		child.stdout.on('data', (value) => {
			text += value
		})
		child.once('error', reject)
		child.once('close', (code) =>
			code === 0 ? accept(text) : reject(new Error(`wl-paste exit ${code}`)),
		)
	})
	assert.equal(clipboard, updated.results[0].title)
	evidence.push({ case: 'actual-wayland-clipboard', copied, clipboard })
	await writeFile(
		plugin,
		originalPlugin.replace(
			'protected override init() {',
			'protected override init() {\n\t\tthrow new Error("receiver acceptance init failure")',
		),
	)
	let failed
	for (let attempt = 0; attempt < 30; attempt++) {
		failed = await dev('default')
		if (
			failed.value.plugins.find((item) => item.rootExportName === 'CalculatorLauncher')
				?.lifecycleState === 'stopped'
		)
			break
		await new Promise((accept) => setTimeout(accept, 100))
	}
	assert.equal(failed.value.update.outcome, 'applied-with-issues')
	const unavailable = await settled(
		(state) => !state.loading && state.results.length === 0,
		'failed generation contribution withdrawal',
	)
	await writeFile(plugin, originalPlugin)
	const recovered = await settled(
		(state) => !state.loading && state.results.length > 0,
		'fixed generation projection',
	)
	evidence.push({ case: 'init-failure-recovery', failed, unavailable, recovered })
	const configured = await dev('configure', 4)
	assert.equal(configured.value.result.application, 'applied')
	const calculated = await dev('calculate', '1/3')
	assert.equal(calculated.value.value.text, '0.3333')
	const cli = await rpc('cli.execute', { argv: ['calc', '1/3'] })
	assert.equal(cli.value.text, '0.3333')
	evidence.push({ case: 'shared-config-cli', configured, calculated, cli })
} finally {
	await writeFile(helper, originalHelper)
	await writeFile(plugin, originalPlugin)
	await mkdir(resolve(root, '.pluxel/acceptance'), { recursive: true })
	await writeFile(
		resolve(root, '.pluxel/acceptance/development.json'),
		JSON.stringify({ root, instance, evidence }, null, 2) + '\n',
	)
}
console.log(
	JSON.stringify({
		passed: evidence.map((item) => item.case),
		file: '.pluxel/acceptance/development.json',
	}),
)
