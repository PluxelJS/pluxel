import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { requirePluginService } from '@pluxel/core/internal'
import { createHost } from '@pluxel/host'
import { setHostCatalogProvenance } from '@pluxel/host/internal'
import { generatePluginControl } from '@pluxel/rolldown/control'
import { createRuntimeManagementClient } from '@pluxel/services/management/client'
import { hashScriptSource, type ScriptArtifact, type ScriptRunSnapshot } from '@pluxel/host/agent'
import { createScriptControlClient, type ScriptControlClient } from '@pluxel/host/agent/transport'
import { elysia } from '@pluxel/services/elysia'
import { listenElysia } from '@pluxel/services/elysia/node'
import { managementAccess } from '@pluxel/services/management/access'
import { management } from '@pluxel/services/management/service'
import { managementHttp } from '@pluxel/services/management/http'
import {
	createRuntimeSessionClient,
	readRuntimeAuthenticationStep,
} from '@pluxel/services/management/session'
import NativeWebSocket from 'crossws/websocket'
import { expect, it } from 'vitest'
import {
	ScriptCliAuthentication,
	SCRIPT_TEST_PASSWORD,
	SCRIPT_TEST_OTHER_PASSWORD,
	scriptTestAuthentication,
	revokeScriptTestAuthorization,
	scriptTestProvider,
} from './fixtures/script-cli-auth'
import { ScriptCounter } from './fixtures/control-sync-counter'

const execute = promisify(execFile)
const HeaderWebSocket = NativeWebSocket as typeof NativeWebSocket & {
	new (
		url: string,
		protocols: string[],
		options: { headers: Record<string, string>; ca: string },
	): WebSocket
}
async function artifact(body: string): Promise<ScriptArtifact> {
	const code = `return { default: async (sdk, run) => { ${body} } };`
	return {
		kind: 'artifact',
		format: 'pluxel-js-factory/1',
		exportName: 'default',
		code,
		sourceHash: await hashScriptSource(code),
	}
}
async function settled(control: ScriptControlClient, id: string): Promise<ScriptRunSnapshot> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const run = await control.result(id)
		if (['succeeded', 'failed', 'cancelled'].includes(run.state)) return run
		await setTimeout(10)
	}
	throw new Error('Run did not settle')
}

it('executes authenticated uploads on a real TLS Host, retaining identity and real cancellation across connections', async () => {
	const address = Object.values(networkInterfaces())
		.flat()
		.find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address
	if (!address)
		throw new Error('A non-loopback IPv4 interface is required to verify provider authentication')
	const directory = await mkdtemp(join(tmpdir(), 'pluxel-script-ws-'))
	const certificate = join(directory, 'certificate.pem'),
		key = join(directory, 'key.pem')
	await execute('openssl', [
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		key,
		'-out',
		certificate,
		'-days',
		'1',
		'-subj',
		'/CN=Pluxel Script Test',
		'-addext',
		`subjectAltName=IP:${address}`,
	])
	const cert = await readFile(certificate, 'utf8')
	await symlink(
		resolve(import.meta.dirname, '../../node_modules'),
		join(directory, 'node_modules'),
		'dir',
	)
	const generation = await generatePluginControl({
		root: resolve(import.meta.dirname, '../..'),
		definitions: [
			{
				moduleId: resolve(import.meta.dirname, 'fixtures/control-sync-counter.ts'),
				className: 'ScriptCounter',
				definition: ScriptCounter.definitionAddress(),
			},
		],
	})
	const makeHost = async (scripts: boolean) => {
		const host = await createHost({
			plugins: [ScriptCliAuthentication, ScriptCounter],
			services: [elysia(), managementAccess(), management(), managementHttp({ scripts })],
			runtime: { documents: { config: false, state: false } },
		})
		setHostCatalogProvenance(
			host.ctx,
			new Map([
				[
					ScriptCounter,
					{
						control: {
							state: 'available',
							format: 1,
							contracts: generation.manifest.definitions[0].contracts,
							material: generation,
						},
					},
				],
			]),
		)
		await host.start()
		await host.startNode(ScriptCliAuthentication.nodeAddress())
		await host.startNode(ScriptCounter.nodeAddress())
		const listener = await listenElysia(host, {
			hostname: address,
			port: 0,
			tls: { cert, key: await readFile(key, 'utf8') },
		})
		return { host, endpoint: `https://${address}:${listener.address.port}` }
	}
	async function connect(endpoint: string, password = SCRIPT_TEST_PASSWORD) {
		const session = createRuntimeSessionClient({
			endpoint,
			webSocket: (url) => new HeaderWebSocket(url, [], { headers: { origin: endpoint }, ca: cert }),
		})
		try {
			let boot = await session.bootstrap(() => {})
			expect(boot.kind).toBe('authentication-required')
			if (boot.kind !== 'authentication-required')
				throw new Error('Provider challenge was bypassed')
			expect(await readRuntimeAuthenticationStep(boot.authentication.stateDto())).toMatchObject({
				kind: 'challenge',
				challenge: { kind: 'password' },
			})
			const step = await readRuntimeAuthenticationStep(boot.authentication.submitDto({ password }))
			if (step.kind !== 'authenticated')
				return {
					session,
					control: undefined as ScriptControlClient | undefined,
					step,
					[Symbol.dispose]: () => session[Symbol.dispose](),
				}
			boot = await session.bootstrap(() => {})
			if (boot.kind === 'authentication-required') throw new Error('Expected authenticated target')
			const control = boot.execution ? createScriptControlClient(boot.execution.dup()) : undefined
			await control?.describe()
			return {
				session,
				control,
				step,
				[Symbol.dispose]() {
					control?.[Symbol.dispose]()
					session[Symbol.dispose]()
				},
			}
		} catch (error) {
			session[Symbol.dispose]()
			throw error
		}
	}
	try {
		const disabled = await makeHost(false)
		try {
			using denied = await connect(disabled.endpoint)
			expect(denied.control).toBeUndefined()
			const boot = denied.session.current
			if (!boot || boot.kind === 'authentication-required')
				throw new Error('Expected authenticated Management')
			const managementClient = createRuntimeManagementClient(boot.management)
			const description = await managementClient.describe()
			expect(description.protocol.capabilities).toContain('plugins.control-materials')
			const index = await managementClient.materials.manifest()
			expect(index.materials).toHaveLength(1)
			expect(index.definitions[0].definition).toEqual(ScriptCounter.definitionAddress())
			const credentials = join(directory, 'sync-credentials.json')
			await writeFile(credentials, JSON.stringify({ password: SCRIPT_TEST_PASSWORD }), {
				mode: 0o600,
			})
			const cli = resolve(import.meta.dirname, '../../../cli/dist/cli.mjs')
			const sync = await execute(
				process.execPath,
				[
					cli,
					'script',
					'sync',
					'--endpoint',
					disabled.endpoint,
					'--credentials-file',
					credentials,
					'--out',
					join(directory, 'synced-control'),
				],
				{
					cwd: directory,
					env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
					timeout: 60_000,
				},
			)
			const synced = JSON.parse(sync.stdout)
			expect(synced).toMatchObject({
				entry: join(directory, 'synced-control/current/index.mjs'),
				definitions: [
					{
						definition: ScriptCounter.definitionAddress(),
						exportName: expect.stringMatching(/^ScriptCounter_[a-f0-9]{16}$/),
					},
				],
			})
			expect(await readFile(synced.entry, 'utf8')).toContain('ScriptCounter')
			expect(sync.stderr).not.toContain(SCRIPT_TEST_PASSWORD)
			const badCredentials = join(directory, 'sync-bad-credentials.json')
			await writeFile(badCredentials, JSON.stringify({ password: 'incorrect' }), { mode: 0o600 })
			await expect(
				execute(
					process.execPath,
					[
						cli,
						'script',
						'sync',
						'--endpoint',
						disabled.endpoint,
						'--credentials-file',
						badCredentials,
						'--out',
						join(directory, 'denied-control'),
					],
					{
						cwd: directory,
						env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
						timeout: 15_000,
					},
				),
			).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('authentication_failed') })
			await expect(
				readFile(join(directory, 'denied-control/current/index.mjs')),
			).rejects.toMatchObject({ code: 'ENOENT' })
		} finally {
			await disabled.host.close()
		}
		const { host, endpoint } = await makeHost(true)
		try {
			{
				using rejected = await connect(endpoint, 'incorrect')
				expect(rejected.step).toEqual({ kind: 'failed', code: 'authentication_failed' })
				expect(rejected.control).toBeUndefined()
			}
			using first = await connect(endpoint)
			if (!first.control) throw new Error('Scripts were not enabled')
			const description = await first.control.describe()
			expect(description).toMatchObject({
				backend: 'node',
				codeKinds: ['artifact'],
				lifetime: 'host',
			})
			const node = ScriptCounter.nodeAddress()
			const change = await artifact(
				`const before = await sdk.config.get(run.input); if (!before.ok) return before; return sdk.config.patch(run.input, {set:{count: before.config.count + 1}}, {expectedManagedRevision:before.managedRevision});`,
			)
			const submitted = { runId: randomUUID(), code: change, input: node }
			const accepted = await first.control.submit(submitted)
			expect(await first.control.submit(submitted)).toMatchObject({
				runId: submitted.runId,
				requestHash: accepted.requestHash,
			})
			expect(await settled(first.control, submitted.runId)).toMatchObject({
				state: 'succeeded',
				value: { config: { count: 3 }, application: 'applied' },
			})
			await expect(first.control.submit({ ...submitted, input: null })).rejects.toMatchObject({
				code: 'request_conflict',
			})
			expect(requirePluginService(host.ctx).getInstance(node)).toMatchObject({ count: 3 })
			first[Symbol.dispose]()
			using reconnected = await connect(endpoint)
			if (!reconnected.control) throw new Error('Scripts were not enabled')
			expect(await reconnected.control.result(submitted.runId)).toMatchObject({
				instanceId: description.instanceId,
				requestHash: accepted.requestHash,
				state: 'succeeded',
			})
			{
				using other = await connect(endpoint, SCRIPT_TEST_OTHER_PASSWORD)
				await expect(other.control!.result(submitted.runId)).rejects.toMatchObject({
					code: 'run_not_found',
				})
			}

			const conflict = {
				runId: randomUUID(),
				input: node,
				code: await artifact(
					`return sdk.config.patch(run.input,{set:{count:99}},{expectedManagedRevision:'outdated'});`,
				),
			}
			await reconnected.control.submit(conflict)
			expect(await settled(reconnected.control, conflict.runId)).toMatchObject({
				state: 'succeeded',
				value: { ok: false, code: 'revision_conflict' },
			})
			const partial = {
				runId: randomUUID(),
				input: node,
				code: await artifact(
					`await sdk.config.patch(run.input,{set:{count:8}}); throw new Error('after persisted change');`,
				),
			}
			await reconnected.control.submit(partial)
			expect(await settled(reconnected.control, partial.runId)).toMatchObject({
				state: 'failed',
				error: { message: 'after persisted change' },
			})
			expect(requirePluginService(host.ctx).getInstance(node)).toMatchObject({ count: 8 })

			const credentials = join(directory, 'credentials.json')
			await writeFile(credentials, JSON.stringify({ password: SCRIPT_TEST_PASSWORD }), {
				mode: 0o600,
			})
			const file = join(directory, 'task.ts')
			await writeFile(
				file,
				`import type { Script } from '@pluxel/host/agent';\nexport default (async (sdk) => ({plugins: (await sdk.plugins.list()).map(p => p.displayName)})) satisfies Script;\n`,
			)
			const cli = resolve(import.meta.dirname, '../../../cli/dist/cli.mjs')
			const result = await execute(
				process.execPath,
				[cli, 'script', 'run', file, '--endpoint', endpoint, '--credentials-file', credentials],
				{
					cwd: resolve(import.meta.dirname, '../../../cli'),
					env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
					timeout: 60_000,
				},
			)
			const output = JSON.parse(result.stdout)
			expect(output).toMatchObject({
				receipt: expect.stringMatching(/^ps2\./),
				run: { state: 'succeeded', value: { plugins: expect.arrayContaining(['ScriptCounter']) } },
			})
			expect(result.stderr).not.toContain(SCRIPT_TEST_PASSWORD)
			expect(
				result.stderr
					.trim()
					.split('\n')
					.map((line) => JSON.parse(line).stage),
			).toEqual(['prepared', 'accepted'])
			const queried = await execute(
				process.execPath,
				[cli, 'script', 'result', output.receipt, '--credentials-file', credentials],
				{
					env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
					timeout: 15_000,
				},
			)
			expect(JSON.parse(queried.stdout).run).toMatchObject({
				runId: output.run.runId,
				requestHash: output.run.requestHash,
				state: 'succeeded',
			})

			const waitForAbort = await artifact(
				`await new Promise(resolve => run.signal.addEventListener('abort',resolve,{once:true})); await new Promise(resolve=>setTimeout(resolve,100)); run.signal.throwIfAborted();`,
			)
			const cancelId = randomUUID()
			await reconnected.control.submit({ runId: cancelId, code: waitForAbort })
			await setTimeout(30)
			expect(await reconnected.control.cancel(cancelId)).toMatchObject({ state: 'cancelling' })
			expect(await reconnected.control.result(cancelId)).toMatchObject({ state: 'cancelling' })
			expect(await settled(reconnected.control, cancelId)).toMatchObject({ state: 'cancelled' })
			const revokedId = randomUUID()
			await reconnected.control.submit({ runId: revokedId, code: waitForAbort })
			await setTimeout(30)
			revokeScriptTestAuthorization()
			await expect(reconnected.control.result(revokedId)).rejects.toBeInstanceOf(Error)
			using newGrant = await connect(endpoint)
			expect(await settled(newGrant.control!, revokedId)).toMatchObject({ state: 'cancelled' })
			const withdrawnId = randomUUID()
			await newGrant.control!.submit({ runId: withdrawnId, code: waitForAbort })
			await setTimeout(30)
			newGrant[Symbol.dispose]()
			scriptTestProvider.registration!.dispose()
			await host.stopNode(ScriptCliAuthentication.nodeAddress())
			await host.startNode(ScriptCliAuthentication.nodeAddress())
			using restoredProvider = await connect(endpoint)
			expect(await settled(restoredProvider.control!, withdrawnId)).toMatchObject({
				state: 'cancelled',
			})

			expect(scriptTestAuthentication.submitted).toBeGreaterThanOrEqual(8)
		} finally {
			await host.close()
		}
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}, 90_000)
