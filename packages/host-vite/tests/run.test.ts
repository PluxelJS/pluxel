import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('owns startup failure cleanup and rejects conflicting production configuration', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-vite-run-'))
	const entry = new URL('../dist/index.mjs', import.meta.url).href
	const sourceShell = new URL('../../workbench/dist/dev.mjs', import.meta.url).href
	const run = (options: Record<string, unknown> = {}, nodeEnv = 'production', prefix = '') =>
		promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`${prefix}; const {runViteApplication}=await import(${JSON.stringify(new URL('../dist/run.mjs', import.meta.url).href)}); const session=await runViteApplication(${JSON.stringify({ root, configFile: 'vite.config.mjs', ...options })}); await session.close(); await session.close(); console.log('CLOSED')`,
			],
			{ env: { ...process.env, NODE_ENV: nodeEnv }, timeout: 12000 },
		)
	const config = (expression: string, extra = '') =>
		writeFile(
			resolve(root, 'vite.config.mjs'),
			`import {host} from ${JSON.stringify(entry)}; ${extra}; export default {logLevel:'silent',plugins:${expression}}`,
		)
	try {
		await writeFile(
			resolve(root, 'app.mjs'),
			'export default () => ({plugins:[],state:{mode:"memory"}})',
		)
		await config('[host({entry:"app.mjs"})]')
		const started = await run()
		expect(started.stdout).toContain('CLOSED')
		await expect(run({}, 'development')).rejects.toThrow('fresh NODE_ENV=production')
		await expect(run({ runtime: 'node' })).rejects.toThrow('unsupported runtime')
		await expect(run({ root: '.' })).rejects.toThrow('root must be absolute')
		await config('[]')
		await expect(run()).rejects.toThrow('exactly one host()')
		await config('[host({entry:"app.mjs"}),host({entry:"app.mjs"})]')
		await expect(run()).rejects.toThrow(/exactly one host\(\)|environment is owned by host/)
		await config('[host({entry:"app.mjs",devConsole:true})]')
		await expect(run()).rejects.toThrow('devConsole is available only in development')
		await config(
			'[host({entry:"app.mjs"}),workbenchSourceShell({entry:"browser.tsx"})]',
			`import {workbenchSourceShell} from ${JSON.stringify(sourceShell)}`,
		)
		await expect(run()).rejects.toThrow('source Shell is available only in development')
		await writeFile(
			resolve(root, 'vite.config.mjs'),
			`import {host} from ${JSON.stringify(entry)}; export default {root:${JSON.stringify(tmpdir())},logLevel:'silent',plugins:[host({entry:"app.mjs"})]}`,
		)
		await expect(run()).rejects.toThrow('conflicts with the execution root')
		await config('[host({entry:"app.mjs"})]')
		await writeFile(
			resolve(root, 'app.mjs'),
			'export default () => ({plugins:[],state:{mode:"memory"},prepare({host}){host.ctx.effects.defer(()=>console.log("DRAINED"));throw new Error("STARTUP_REJECTED")}})',
		)
		await expect(run()).rejects.toMatchObject({
			stdout: expect.stringContaining('DRAINED'),
			stderr: expect.stringContaining('STARTUP_REJECTED'),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 60000)

it('reports Host and plugin shutdown failures while draining remaining resources', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-vite-shutdown-'))
	try {
		await writeFile(
			resolve(root, 'vite.config.mjs'),
			`import {host} from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
export default {logLevel:'silent',plugins:[host({entry:'app.mjs'}),{
 name:'test:shutdown-failure',applyToEnvironment(environment){return environment.name==='pluxel'},
 closeBundle(){console.log('PLUGIN_DRAINED');throw new Error('PLUGIN_CLOSE_FAILED')}
},{
 name:'test:sequential-cleanup',applyToEnvironment(environment){return environment.name==='pluxel'},
 closeBundle:{sequential:true,async handler(){await new Promise(resolve=>setTimeout(resolve,5));console.log('SEQUENTIAL_DRAINED')}}
}]}`,
		)
		await writeFile(
			resolve(root, 'app.mjs'),
			`export default (startup)=>({plugins:[],state:{mode:'memory'},prepare({host}){
 host.ctx.effects.defer(()=>console.log('HOST_DRAINED_AFTER_FAILURE'));
 host.ctx.effects.defer(()=>{console.log('HOST_DRAINED_FAILURE');throw new Error('HOST_CLOSE_FAILED')});
 if(startup.env.FAIL_STARTUP==='yes')throw new Error('STARTUP_FAILED');
}})`,
		)
		for (const failStartup of [false, true]) {
			const result = await promisify(execFile)(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`import assert from 'node:assert/strict';
const {runViteApplication}=await import(${JSON.stringify(new URL('../dist/run.mjs', import.meta.url).href)});
const flatten=(error)=>[error,...(error instanceof AggregateError?error.errors.flatMap(flatten):[])];
let session;let failure;
try{session=await runViteApplication({root:${JSON.stringify(root)},configFile:'vite.config.mjs'});await session.close()}catch(error){failure=error}
assert(failure instanceof AggregateError);
assert.strictEqual(failure.cause,failure.errors[0]);
const messages=flatten(failure).map(error=>error.message);
assert(messages.includes('HOST_CLOSE_FAILED'),messages.join(';'));
assert(messages.includes('PLUGIN_CLOSE_FAILED'),messages.join(';'));
if(${failStartup})assert(messages.includes('STARTUP_FAILED'),messages.join(';'));
else{assert(session);await assert.rejects(session.close(),error=>error===failure)}
await new Promise(resolve=>setTimeout(resolve,5));
assert.deepEqual(process.getActiveResourcesInfo().filter(name=>['FSEventWrap','FSWatcher','StatWatcher','TCPServerWrap'].includes(name)),[]);
console.log('SHUTDOWN_FAILURE_OBSERVED');`,
				],
				{
					env: { ...process.env, NODE_ENV: 'production', FAIL_STARTUP: failStartup ? 'yes' : 'no' },
					timeout: 12000,
				},
			)
			expect(result.stdout).toContain('HOST_DRAINED_AFTER_FAILURE')
			expect(result.stdout).toContain('PLUGIN_DRAINED')
			expect(result.stdout).toContain('SEQUENTIAL_DRAINED')
			expect(result.stdout).toContain('SHUTDOWN_FAILURE_OBSERVED')
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30000)

it.each(['abort', 'close'] as const)(
	'keeps %s ownership when options change during async configuration',
	async (action) => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-vite-startup-abort-'))
		try {
			await writeFile(
				resolve(root, 'vite.config.mjs'),
				`import {host} from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
const options={entry:'app.mjs',devConsole:false};const plugins=host(options);
await new Promise(resolve=>setTimeout(resolve,40));
options.entry='missing-app.mjs';options.devConsole=true;
export default {logLevel:'silent',plugins}`,
			)
			await writeFile(
				resolve(root, 'app.mjs'),
				`if(process.env.SHOULD_EVALUATE!=='yes')throw new Error('ABORTED_APPLICATION_EVALUATED');
export default()=>({plugins:[],state:{mode:'memory'},prepare({host}){host.ctx.effects.defer(()=>console.log('APP_DRAINED'))}})`,
			)
			const result = await promisify(execFile)(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`import assert from 'node:assert/strict';import {getEventListeners} from 'node:events';
const {runViteApplication}=await import(${JSON.stringify(new URL('../dist/run.mjs', import.meta.url).href)});
const abort=new AbortController();const reason=new Error('STARTUP_ABORTED');
const replacement=new AbortController();
const options={root:${JSON.stringify(root)},configFile:'vite.config.mjs',signal:abort.signal};
const starting=runViteApplication(options);
options.root='/not-the-startup-root';options.configFile='missing-config.mjs';options.signal=replacement.signal;
if(${action === 'abort'}){setTimeout(()=>abort.abort(reason),5);await assert.rejects(starting,error=>error===reason)}
else{const session=await starting;await session.close()}
assert.deepEqual(getEventListeners(abort.signal,'abort'),[]);
assert.deepEqual(getEventListeners(replacement.signal,'abort'),[]);
await new Promise(resolve=>setTimeout(resolve,5));
assert.deepEqual(process.getActiveResourcesInfo().filter(name=>['FSEventWrap','FSWatcher','StatWatcher','TCPServerWrap'].includes(name)),[]);
console.log('OPTIONS_OWNER_DRAINED');`,
				],
				{
					env: {
						...process.env,
						NODE_ENV: 'production',
						SHOULD_EVALUATE: action === 'close' ? 'yes' : 'no',
					},
					timeout: 12000,
				},
			)
			expect(result.stdout).toContain('OPTIONS_OWNER_DRAINED')
			expect(result.stdout.includes('APP_DRAINED')).toBe(action === 'close')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
	15000,
)
