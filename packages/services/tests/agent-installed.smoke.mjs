// Real package receiver acceptance. The target has only the relocated application distribution.
import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPackageJSON } from 'node:module'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'pluxel-agent-installed-'))
const author = join(root, 'author')
const receiver = join(root, 'receiver')
const environment = {
	...process.env,
	PNPM_CONFIG_PM_ON_FAIL: 'ignore',
}
delete environment.NODE_OPTIONS
const ip = Object.values(networkInterfaces())
	.flat()
	.find((item) => item?.family === 'IPv4' && !item.internal)?.address
assert.ok(ip, 'A real non-loopback IPv4 interface is required to exercise provider authentication')
let server
let serverOutput = ''
let serverErrors = ''

async function run(file, args, cwd, overrides = {}) {
	try {
		return await execFile(file, args, {
			cwd,
			env: { ...environment, ...overrides },
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
		})
	} catch (error) {
		throw new Error(
			`${file} ${args[0] ?? ''} failed: ${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
			{ cause: error },
		)
	}
}
async function packageVersion(name, owner = 'rolldown') {
	const manifest = JSON.parse(
		await readFile(
			join(workspace, 'packages', owner, 'node_modules', name, 'package.json'),
			'utf8',
		),
	)
	return manifest.name === name ? manifest.version : `npm:${manifest.name}@${manifest.version}`
}
async function listFiles(directory, prefix = '') {
	const result = []
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(prefix, entry.name)
		if (entry.isDirectory()) result.push(...(await listFiles(join(directory, entry.name), path)))
		else result.push(path)
	}
	return result
}
async function closeServer() {
	if (!server || server.exitCode !== null || server.signalCode !== null) return
	const exit = once(server, 'exit', { signal: AbortSignal.timeout(10_000) })
	server.kill('SIGTERM')
	try {
		const [code, signal] = await exit
		assert.equal(signal, null)
		assert.equal(code, 0, serverErrors)
	} catch (error) {
		server.kill('SIGKILL')
		throw error
	}
}

async function main() {
	try {
		await mkdir(author)
		await mkdir(receiver)
		const packages = {}
		for (const name of [
			'core',
			'host',
			'commands',
			'services',
			'rolldown',
			'cli',
			'valibot-form',
		]) {
			const tarball = join(root, `${name}.tgz`)
			await run('pnpm', ['pack', '--out', tarball], join(workspace, 'packages', name), {
				PNPM_CONFIG_WORKSPACE_DIR: workspace,
			})
			packages[name === 'valibot-form' ? name : `@pluxel/${name}`] = `file:${tarball}`
		}
		const elysiaEntry = pathToFileURL(
			await realpath(new URL('../node_modules/elysia/dist/index.mjs', import.meta.url)),
		)
		const dependencies = {
			...packages,
			vite: await packageVersion('vite'),
			rolldown: await packageVersion('rolldown'),
			'vite-plus': await packageVersion('vite-plus'),
			typescript: await packageVersion('typescript'),
			valibot: await packageVersion('valibot', 'services'),
			elysia: await packageVersion('elysia', 'services'),
			capnweb: await packageVersion('capnweb', 'services'),
			typebox: JSON.parse(await readFile(findPackageJSON('typebox', elysiaEntry), 'utf8')).version,
			'exact-mirror': JSON.parse(
				await readFile(findPackageJSON('exact-mirror', elysiaEntry), 'utf8'),
			).version,
			'openapi-types': JSON.parse(
				await readFile(findPackageJSON('openapi-types', elysiaEntry), 'utf8'),
			).version,
			'@types/node': await packageVersion('@types/node'),
			'@types/bun': JSON.parse(await readFile(findPackageJSON('@types/bun', elysiaEntry), 'utf8'))
				.version,
		}
		await writeFile(
			join(author, 'package.json'),
			JSON.stringify({
				name: 'installed-agent-author',
				version: '1.0.0',
				private: true,
				type: 'module',
				exports: { '.': './app.ts' },
				dependencies,
			}),
		)
		await writeFile(
			join(author, 'pnpm-workspace.yaml'),
			JSON.stringify({
				packages: ['.'],
				overrides: { ...packages, vite: dependencies.vite },
				autoInstallPeers: false,
			}),
		)
		await run('pnpm', ['--dir', author, 'install', '--prefer-offline', '--ignore-scripts'], author)
		for (const name of Object.keys(packages)) {
			const installedPath = await realpath(join(author, 'node_modules', name))
			assert.ok(!installedPath.startsWith(workspace), `${name} must be independently installed`)
		}
		await writeFile(
			join(author, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					target: 'ES2023',
					module: 'ESNext',
					moduleResolution: 'Bundler',
					strict: true,
					skipLibCheck: true,
					noEmit: true,
					types: ['node'],
					experimentalDecorators: true,
					lib: ['ESNext', 'DOM'],
				},
				include: ['*.ts'],
			}),
		)
		await writeFile(
			join(author, 'auth.ts'),
			await readFile(new URL('./management/fixtures/script-cli-auth.ts', import.meta.url), 'utf8'),
		)
		await writeFile(join(author, 'app.ts'), application)
		await writeFile(
			join(author, 'build.mjs'),
			`import {build} from 'vite-plus/pack';import {pluxel} from '@pluxel/rolldown';await build({cwd:process.cwd(),entry:'app.ts',outDir:'dist',config:false,dts:false,minify:true,sourcemap:false,outputOptions:{codeSplitting:false},plugins:[pluxel({delivery:'standalone',variant:'headless',managedDatabaseDrivers:[],lint:false})]});`,
		)
		await run(process.execPath, ['build.mjs'], author)
		await cp(join(author, 'dist'), receiver, { recursive: true })
		// Only the receiver owns the application code now; CLI sources are separate portable task modules.
		await rm(join(author, 'app.ts'))
		await rm(join(author, 'auth.ts'))
		await rm(join(author, 'build.mjs'))
		await rm(join(author, 'dist'), { recursive: true })
		const receiverFiles = await listFiles(receiver)
		assert.deepEqual(
			receiverFiles
				.filter((file) => /\.(?:mjs|cjs|js)$/.test(file) && !file.startsWith('node_modules/'))
				.sort(),
			['app.mjs', 'control/index.mjs'],
		)
		assert.ok(
			receiverFiles.every(
				(file) =>
					!/(?:^|\/)(?:typescript|vite|vite-plus|rolldown|workbench|host-vite|src)(?:\/|$)|(?<!\.d)\.tsx?$/.test(
						file,
					),
			),
			'The receiver must not contain original TypeScript, compiler or development packages',
		)
		await run(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-keyout',
				'tls.key',
				'-out',
				'tls.crt',
				'-days',
				'1',
				'-subj',
				'/CN=pluxel-agent-installed',
				'-addext',
				`subjectAltName=IP:${ip}`,
			],
			receiver,
		)
		const guard = `import{registerHooks}from'node:module';import{fileURLToPath}from'node:url';import{realpathSync}from'node:fs';const root=realpathSync(process.cwd())+'/';registerHooks({load(url,context,next){if(url.startsWith('file:')&&!fileURLToPath(url).startsWith(root))throw new Error('Receiver loaded a module outside its distribution: '+url);return next(url,context)}});`
		server = spawn(
			process.execPath,
			['--import', `data:text/javascript,${encodeURIComponent(guard)}`, 'app.mjs'],
			{
				cwd: receiver,
				env: { ...environment, AGENT_SMOKE_HOST: ip },
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
		server.stdout.setEncoding('utf8')
		server.stderr.setEncoding('utf8')
		server.stdout.on('data', (text) => {
			serverOutput = (serverOutput + text).slice(-1024 * 1024)
		})
		server.stderr.on('data', (text) => {
			serverErrors = (serverErrors + text).slice(-1024 * 1024)
		})
		const lines = createInterface({ input: server.stdout })
		const ready = await new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`Receiver startup timed out\n${serverOutput}\n${serverErrors}`)),
				30_000,
			)
			lines.on('line', (line) => {
				if (!line.startsWith('{')) return
				const value = JSON.parse(line)
				if (value.stage === 'ready') {
					clearTimeout(timeout)
					resolve(value)
				}
			})
			server.once('exit', (code) => {
				clearTimeout(timeout)
				reject(new Error(`Receiver exited ${code}\n${serverOutput}\n${serverErrors}`))
			})
		})
		const credentials = join(author, 'credentials.json')
		const wrongCredentials = join(author, 'wrong-credentials.json')
		await writeFile(credentials, JSON.stringify({ password: 'local-test-script-password' }), {
			mode: 0o600,
		})
		await writeFile(wrongCredentials, JSON.stringify({ password: 'wrong' }), { mode: 0o600 })
		const cliBin = join(author, 'node_modules/@pluxel/cli/bin/pluxel.mjs')
		const cliEnvironment = { NODE_EXTRA_CA_CERTS: join(receiver, 'tls.crt') }
		async function cli(args, expectedCode = 0) {
			let result,
				code = 0
			try {
				result = await execFile(
					process.execPath,
					[cliBin, 'script', ...args, '--credentials-file', credentials],
					{
						cwd: author,
						env: { ...environment, ...cliEnvironment },
						timeout: 30_000,
						maxBuffer: 4 * 1024 * 1024,
					},
				)
			} catch (error) {
				code = error.code
				result = error
			}
			if (expectedCode !== null)
				assert.equal(code, expectedCode, `${result.stdout}\n${result.stderr}`)
			const output = JSON.parse(result.stdout.trim())
			if (expectedCode === 0) assert.ok(!output.error, JSON.stringify(output))
			return output
		}
		const synchronized = await cli(['sync', '--endpoint', ready.endpoint, '--out', 'control'])
		const counter = synchronized.definitions.filter(
			(item) => item.definition.exportName === 'Counter',
		)
		assert.equal(counter.length, 1, JSON.stringify(synchronized))
		const controlImport = `import {${counter[0].exportName} as Counter} from './control/current/index.mjs'\n`
		const synchronizedAgain = await cli(['sync', '--endpoint', ready.endpoint, '--out', 'control'])
		assert.equal(synchronizedAgain.snapshot, synchronized.snapshot)
		await writeFile(join(author, 'task.ts'), controlImport + task)
		const first = await cli(['run', 'task.ts', '--endpoint', ready.endpoint])
		assert.equal(first.run.state, 'succeeded')
		assert.equal(first.run.value.moduleRuns, 1)
		assert.equal(first.run.value.actual.config.count, 4)
		assert.deepEqual(first.run.value.business, { calls: 3, count: 4 })
		assert.equal(first.run.value.calls, 3)
		assert.equal(first.run.value.actual.application, 'applied')
		assert.equal(first.run.value.actual.desiredRevision, first.run.value.actual.appliedRevision)
		assert.equal(first.run.value.conflict.code, 'revision_conflict')
		assert.ok(first.run.value.logs.ok && first.run.value.logs.lines.length > 0)
		assert.equal(first.run.value.lifecycle.lifecycleState, 'running')
		const second = await cli(['run', 'task.ts', '--endpoint', ready.endpoint])
		assert.equal(second.run.value.moduleRuns, 1)
		assert.equal(second.run.value.actual.config.count, 8)
		assert.deepEqual(second.run.value.business, { calls: 3, count: 8 })
		// A new authenticated connection queries the original receipt; no source re-delivery occurs.
		const queried = await cli(['result', first.receipt])
		assert.equal(queried.run.runId, first.run.runId)
		assert.equal(queried.run.requestHash, first.run.requestHash)
		await writeFile(join(author, 'failure.ts'), failure)
		const failed = await cli(['run', 'failure.ts', '--endpoint', ready.endpoint], 1)
		assert.equal(failed.run.state, 'failed')
		assert.equal(failed.run.phase, 'execute')
		assert.ok(
			failed.run.error.stack.includes(`${join(author, 'failure.ts')}:5:`),
			failed.run.error.stack,
		)
		await writeFile(join(author, 'query.ts'), query)
		const afterFailure = await cli(['run', 'query.ts', '--endpoint', ready.endpoint])
		assert.equal(afterFailure.run.value.config.count, 11)
		await writeFile(join(author, 'wait.ts'), wait)
		const waiting = await cli([
			'run',
			'wait.ts',
			'--endpoint',
			ready.endpoint,
			'--detach',
			'--timeout',
			'120000',
		])
		assert.ok(!['failed', 'cancelled', 'succeeded'].includes(waiting.run.state))
		await cli(['cancel', waiting.receipt], null)
		let cancelled
		for (let attempt = 0; attempt < 20; attempt++) {
			cancelled = await cli(['result', waiting.receipt], null)
			if (['succeeded', 'failed', 'cancelled'].includes(cancelled.run.state)) break
			await delay(25)
		}
		assert.equal(cancelled.run.state, 'cancelled')
		let denied
		try {
			await execFile(
				process.execPath,
				[
					cliBin,
					'script',
					'run',
					'query.ts',
					'--endpoint',
					ready.endpoint,
					'--credentials-file',
					wrongCredentials,
				],
				{ cwd: author, env: { ...environment, ...cliEnvironment }, timeout: 30_000 },
			)
		} catch (error) {
			denied = JSON.parse(error.stdout.trim())
		}
		assert.equal(denied?.error?.code, 'authentication_failed')
		if (process.env.PLUXEL_AGENT_REVIEW_STDIO === '1') {
			process.stdout.write(
				JSON.stringify({
					stage: 'review',
					author,
					receiver,
					endpoint: ready.endpoint,
					credentials,
					cliBin,
					receipt: first.receipt,
				}) + '\n',
			)
			await once(process.stdin, 'data', { signal: AbortSignal.timeout(180_000) })
			process.stdin.pause()
		}
		await closeServer()
		const closed = serverOutput
			.split('\n')
			.filter((line) => line.startsWith('{'))
			.map((line) => JSON.parse(line))
			.find((value) => value.stage === 'closed')
		assert.ok(
			closed?.authentication.submitted >= 8,
			'Independent CLI requests must pass real provider challenges',
		)
		console.log('INSTALLED_AGENT_CLI_NODE_OK')
	} catch (error) {
		console.error(`Installed agent receiver output:\n${serverOutput}\n${serverErrors}`)
		throw error
	} finally {
		try {
			await closeServer()
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	}
}

const application = `
import {readFile} from 'node:fs/promises'
import {BasePlugin,Plugin} from '@pluxel/core'
import {logtape} from '@pluxel/core/config'
import {defineHostApplication,type HostApplication} from '@pluxel/host'
import {elysia} from '@pluxel/services/elysia'
import {listenElysia} from '@pluxel/services/elysia/node'
import {managementAccess} from '@pluxel/services/management/access'
import {management} from '@pluxel/services/management/service'
import {managementHttp} from '@pluxel/services/management/http'
import {ScriptCliAuthentication,scriptTestAuthentication} from './auth'
import * as v from 'valibot'
export {ScriptCliAuthentication}
const Schema=v.object({count:v.optional(v.number(),2)})
@Plugin({displayName:'Installed counter'})
export class Counter extends BasePlugin {
 readonly config=this.configs.use(Schema)
 calls=0
 async increment(by:number){await Promise.resolve();this.calls+=by;return {calls:this.calls,count:this.config.count}}
 protected init(){this.ctx.logger.info('installed counter started');this.configs.onUpdate(this.config,({desired})=>{this.ctx.logger.info('adopted {count}',{count:desired.count})})}
}
export default defineHostApplication((startup):HostApplication=>({
 plugins:[ScriptCliAuthentication,Counter],
 services:[elysia(),managementAccess(),management(),managementHttp({scripts:true})],
 runtime:{documents:{config:false,state:false},logtape:logtape(({createRuntimeLogSink})=>({sinks:{history:createRuntimeLogSink({windowLines:100})},loggers:[{category:['pluxel'],lowestLevel:'trace',sinks:['history']},{category:['logtape','meta'],lowestLevel:'fatal',sinks:[]}]}))},
 policy:{autoStart:[ScriptCliAuthentication,Counter]},
 prepare:({host})=>{host.ctx.effects.defer(()=>{process.stdout.write(JSON.stringify({stage:'closed',authentication:scriptTestAuthentication})+'\\n')},{tag:'AgentSmokeShutdown',phase:'shutdown'})},
 launch:async({host})=>{const listener=await listenElysia(host,{hostname:startup.env.AGENT_SMOKE_HOST,port:0,tls:{key:await readFile('tls.key','utf8'),cert:await readFile('tls.crt','utf8')}});process.stdout.write(JSON.stringify({stage:'ready',endpoint:'https://'+listener.address.host+':'+listener.address.port})+'\\n')},
}))
`
const task = `import type {Script} from '@pluxel/host/agent'
let moduleRuns=0
export default (async sdk=>{
 const select=sdk.plugin
 const counter=select(Counter)
 const {get,patch}=counter.config
 const {stop,start,restart,status,instance:borrow}=counter
 const before=await get();if(!before.ok)return before
 const count=[before.config.count].map(value=>value*2)[0]
 const changed=await patch({set:{count}},{expectedManagedRevision:before.managedRevision});if(!changed.ok)return changed
 const conflict=await patch({set:{count:999}},{expectedManagedRevision:before.managedRevision})
 const cursor=await sdk.logs.mark();await stop();await start();await restart()
 const logs=await sdk.logs.read(cursor,{filter:{plugin:Counter},limit:20})
 const {instance}=await borrow()
 const business=await instance.increment(3)
 return {moduleRuns:++moduleRuns,changed,conflict,logs,business,calls:instance.calls,actual:await get(),lifecycle:await status()}
}) satisfies Script
`
const failure = `import type {Script} from '@pluxel/host/agent'
export default (async sdk=>{
 const node=(await sdk.plugins.list()).find(node=>node.displayName==='Installed counter')!.address
 await sdk.plugin(node).config.patch({set:{count:11}})
 throw new Error('author failed after committing')
}) satisfies Script
`
const query = `import type {Script} from '@pluxel/host/agent';export default(async sdk=>{const node=(await sdk.plugins.list()).find(node=>node.displayName==='Installed counter')!.address;return sdk.plugin(node).config.get()}) satisfies Script`
const wait = `import type {Script} from '@pluxel/host/agent';export default(async sdk=>{const cursor=await sdk.logs.mark();return sdk.logs.wait(cursor,{timeoutMs:120000,filter:{category:'not-emitted'}})}) satisfies Script`

await main()
