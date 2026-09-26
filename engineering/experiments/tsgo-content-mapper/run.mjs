import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { cp, mkdir, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = dirname(fileURLToPath(import.meta.url))
if (!process.argv[2])
	throw new Error('Pass the path to typescript@7.1.0-dev.20260922.1/bin/tsc; see README.md')
const compiler = resolve(process.argv[2])
const artifacts = resolve(root, '.artifacts')
await rm(artifacts, { recursive: true, force: true })
await mkdir(resolve(artifacts, 'node_modules/@pluxel'), { recursive: true })
await symlink(
	resolve(root, 'mapper'),
	resolve(artifacts, 'node_modules/@pluxel/experiment-content-mapper'),
	'dir',
)
const options = {
	strict: true,
	target: 'es2022',
	module: 'esnext',
	moduleResolution: 'bundler',
	types: [],
	declaration: true,
	emitDeclarationOnly: true,
	outDir: './dist',
	skipLibCheck: false,
}
const mapper = (extensions) => [{ package: '@pluxel/experiment-content-mapper', extensions }]
const writeJSON = (path, value) => writeFile(path, JSON.stringify(value, null, 2))
function tsc(args) {
	const run = spawnSync(process.execPath, [compiler, ...args], {
		cwd: artifacts,
		encoding: 'utf8',
		timeout: 30000,
	})
	if (run.error) throw run.error
	return { code: run.status, output: run.stdout + run.stderr }
}
const report = { version: tsc(['--version']).output.trim() }
await cp(resolve(root, 'fixtures'), artifacts, { recursive: true })
await writeFile(resolve(artifacts, 'plain.ts'), 'export const value = 1\n')
const installedCompiler = resolve(root, '../../../node_modules/typescript/bin/tsc')
await writeJSON(resolve(artifacts, 'tsconfig.installed.json'), {
	compilerOptions: { ...options, noEmit: true },
	files: ['plain.ts'],
	contentMappers: [{ package: 'this-package-does-not-exist', extensions: ['.ts'] }],
})
const installed = (args) => {
	const run = spawnSync(process.execPath, [installedCompiler, ...args], {
		cwd: artifacts,
		encoding: 'utf8',
		timeout: 30000,
	})
	return { code: run.status, output: run.stdout + run.stderr }
}
report.installed = {
	version: installed(['--version']).output.trim(),
	ignoredConfig: installed(['-p', 'tsconfig.installed.json', '--pretty', 'false']),
	optInFlag: installed(['-p', 'tsconfig.installed.json', '--runExternalCode', '--pretty', 'false']),
}

for (const ext of ['.ts', '.tsx']) {
	const config = `tsconfig.reject${ext}.json`
	await writeJSON(resolve(artifacts, config), {
		compilerOptions: { ...options, noEmit: true },
		files: ['plain.ts'],
		contentMappers: mapper([ext]),
	})
	report[ext] = tsc(['-p', config, '--runExternalCode', '--pretty', 'false'])
	assert.match(report[ext].output, /TS100021/)
}
await writeJSON(resolve(artifacts, 'tsconfig.json'), {
	compilerOptions: options,
	files: ['plugin.pluxel', 'host.ts'],
	contentMappers: mapper(['.pluxel']),
})
report.withoutOptIn = tsc(['-p', 'tsconfig.json', '--pretty', 'false'])
report.valid = tsc(['-p', 'tsconfig.json', '--runExternalCode', '--pretty', 'false'])
assert.equal(report.valid.code, 0, report.valid.output)
report.javascriptEmit = tsc([
	'-p',
	'tsconfig.json',
	'--runExternalCode',
	'--emitDeclarationOnly',
	'false',
	'--outDir',
	'./js',
	'--pretty',
	'false',
])
report.javascriptFiles = await readdir(resolve(artifacts, 'js'))
report.emittedFiles = await readdir(resolve(artifacts, 'dist'))
report.declarations = Object.fromEntries(
	await Promise.all(
		report.emittedFiles.map(async (name) => [
			name,
			await readFile(resolve(artifacts, 'dist', name), 'utf8'),
		]),
	),
)
const hostFile = resolve(artifacts, 'host.ts')
const hostText = await readFile(hostFile, 'utf8')
await writeFile(hostFile, hostText + "\ndefineBinding(DemoPlugin, { typo: 'BAD' })\n")
report.invalid = tsc(['-p', 'tsconfig.json', '--runExternalCode', '--noEmit', '--pretty', 'false'])
assert.match(report.invalid.output, /typo/)
await writeFile(hostFile, hostText)

// Check consumer portability using emitted files only, without registering a mapper.
await mkdir(resolve(artifacts, 'consumer'), { recursive: true })
await cp(resolve(artifacts, 'dist'), resolve(artifacts, 'consumer/lib'), { recursive: true })
await writeFile(
	resolve(artifacts, 'consumer/use.ts'),
	"import type { PluginInputs } from './lib/host'\nexport const input: PluginInputs = {endpoint: 'x', retries: '3'}\n",
)
await writeJSON(resolve(artifacts, 'consumer/tsconfig.json'), {
	compilerOptions: { ...options, noEmit: true, emitDeclarationOnly: false },
	files: ['use.ts'],
})
report.declarationConsumer = tsc(['-p', 'consumer/tsconfig.json', '--pretty', 'false'])
assert.equal(report.declarationConsumer.code, 0, report.declarationConsumer.output)
report.installed.declarationConsumer = installed([
	'-p',
	'consumer/tsconfig.json',
	'--pretty',
	'false',
])
assert.equal(
	report.installed.declarationConsumer.code,
	0,
	report.installed.declarationConsumer.output,
)
await writeFile(
	resolve(artifacts, 'consumer/use.ts'),
	"import type { PluginInputs } from './lib/host'\nexport const input: PluginInputs = {endpoint: 'x', retries: 3}\n",
)
report.invalidDeclarationConsumer = tsc(['-p', 'consumer/tsconfig.json', '--pretty', 'false'])
assert.match(report.invalidDeclarationConsumer.output, /TS2322/)

const server = spawn(process.execPath, [compiler, '--lsp', '--stdio'], {
	cwd: artifacts,
	stdio: ['pipe', 'pipe', 'pipe'],
})
let buffer = Buffer.alloc(0),
	id = 0
const requests = new Map()
const send = (message) => {
	const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
	server.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
	server.stdin.write(body)
}
const request = (method, params) =>
	new Promise((resolve, reject) => {
		const current = ++id
		const timeout = setTimeout(() => {
			requests.delete(current)
			reject(new Error(`LSP timeout: ${method}`))
		}, 15000)
		requests.set(current, (message) => {
			clearTimeout(timeout)
			message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
		})
		send({ id: current, method, params })
	})
server.stdout.on('data', (chunk) => {
	buffer = Buffer.concat([buffer, chunk])
	for (;;) {
		const header = buffer.indexOf('\r\n\r\n')
		if (header < 0) return
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, header).toString())[1])
		if (buffer.length < header + 4 + length) return
		const message = JSON.parse(buffer.subarray(header + 4, header + 4 + length))
		buffer = buffer.subarray(header + 4 + length)
		if (message.method && message.id !== undefined)
			send({
				id: message.id,
				result:
					message.method === 'workspace/configuration'
						? (message.params.items ?? []).map(() => ({}))
						: null,
			})
		else if (requests.has(message.id)) {
			requests.get(message.id)(message)
			requests.delete(message.id)
		}
	}
})
let stderr = ''
server.stderr.on('data', (chunk) => {
	stderr += chunk
})
try {
	report.lspInitialize = await request('initialize', {
		processId: process.pid,
		rootUri: pathToFileURL(artifacts).href,
		capabilities: { textDocument: { completion: { completionItem: { snippetSupport: true } } } },
		initializationOptions: { runExternalCode: true },
	})
	send({ method: 'initialized', params: {} })
	const uri = pathToFileURL(hostFile).href
	send({
		method: 'textDocument/didOpen',
		params: { textDocument: { uri, languageId: 'typescript', version: 1, text: hostText } },
	})
	const lines = hostText.split('\n')
	const line = lines.findIndex((line) => line.includes('export const retryInput'))
	report.hover = await request('textDocument/hover', {
		textDocument: { uri },
		position: { line, character: lines[line].indexOf('retryInput') + 2 },
	})
	assert.match(JSON.stringify(report.hover), /string/)
	const bindingLine = lines.findIndex((line) => line.includes('export const binding'))
	report.completion = await request('textDocument/completion', {
		textDocument: { uri },
		position: { line: bindingLine, character: lines[bindingLine].indexOf('endpoint') },
		context: { triggerKind: 1 },
	})
	const entries = Array.isArray(report.completion) ? report.completion : report.completion.items
	report.completionLabels = entries.map((item) => item.label)
	assert.ok(
		report.completionLabels.some((label) => label.replace(/\?$/, '') === 'enabled'),
		JSON.stringify(report.completionLabels),
	)
	delete report.completion
	delete report.lspInitialize
	send({
		method: 'textDocument/didChange',
		params: {
			textDocument: { uri, version: 2 },
			contentChanges: [{ text: hostText + "\ndefineBinding(DemoPlugin, { typo: 'BAD' })\n" }],
		},
	})
	report.lspDiagnostics = await request('textDocument/diagnostic', { textDocument: { uri } })
	assert.match(JSON.stringify(report.lspDiagnostics), /typo/)
	await request('shutdown', undefined)
	send({ method: 'exit' })
} finally {
	server.kill()
	report.lspStderr = stderr
}
await writeJSON(resolve(artifacts, 'report.json'), report)
console.log(JSON.stringify(report, null, 2))
