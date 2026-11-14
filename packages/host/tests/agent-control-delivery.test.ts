import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePluginControl } from '@pluxel/rolldown/control'
import { compileScript } from '@pluxel/rolldown/scripts'
import { requirePluginService } from '@pluxel/core/internal'
import { expect, it } from 'vitest'
import { createHost } from '../src'
import { setHostCatalogProvenance } from '../src/internal'
import { SCRIPT_PROTOCOL, scriptRequestHash } from '../src/agent'
import { createNodeScriptOwner } from '../src/agent/node'
import { createScriptControlTarget } from '../src/agent/transport'
import { DeliveryCounter } from './fixtures/control-delivery-plugin'

const hostRoot = fileURLToPath(new URL('../', import.meta.url))
const pluginFile = fileURLToPath(new URL('./fixtures/control-delivery-plugin.ts', import.meta.url))

it('generates real Plugin declarations, compiles an author script and uploads it to the original Host instance', async () => {
	await mkdir(join(hostRoot, '.tmp'), { recursive: true })
	const directory = await mkdtemp(join(hostRoot, '.tmp/control-delivery-'))
	const host = await createHost({
		plugins: [DeliveryCounter],
		runtime: { documents: { state: false, config: false } },
	})
	let owner: ReturnType<typeof createNodeScriptOwner> | undefined
	try {
		const generation = await generatePluginControl({
			root: hostRoot,
			definitions: [
				{
					moduleId: pluginFile,
					className: 'DeliveryCounter',
					definition: DeliveryCounter.definitionAddress(),
				},
			],
		})
		const entry = generation.manifest.definitions[0]!
		setHostCatalogProvenance(
			host.ctx,
			new Map([
				[
					DeliveryCounter,
					{
						control: {
							state: 'available',
							format: 1,
							contracts: entry.contracts,
							material: {
								snapshot: generation.snapshot,
								manifest: generation.manifest,
								files: generation.files,
							},
						},
					},
				],
			]),
		)
		for (const [path, contents] of Object.entries(generation.files)) {
			const output = join(directory, 'control', path)
			await mkdir(dirname(output), { recursive: true })
			await writeFile(output, contents)
		}
		await mkdir(join(directory, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['host', 'core'])
			await symlink(
				join(hostRoot, '..', name),
				join(directory, 'node_modules/@pluxel', name),
				'dir',
			)
		await writeFile(
			join(directory, 'tsconfig.json'),
			JSON.stringify({ extends: join(hostRoot, 'tsconfig.json') }),
		)
		const source = join(directory, 'task.ts')
		await writeFile(
			source,
			`
import type { Script } from '@pluxel/host/agent'
import { DeliveryCounter } from './control/index.mjs'
export default ((sdk, run) => sdk.Result.gen(async function* () {
  const selected = sdk.plugin(DeliveryCounter)
  const { get, patch } = selected.config
  const before = yield* sdk.Result.await(get())
  const changed = yield* sdk.Result.await(patch({ set: { count: 12 } }, { expectedManagedRevision: before.managedRevision }))
  if (changed.application !== 'applied') return sdk.Result.ok(changed)
  const counter = yield* sdk.Result.await(selected.instance())
  const added = await counter.addAsync(5, run.signal)
  return sdk.Result.ok({ changed, added, observed: counter.count })
})) satisfies Script
export const encodeFailure = (async (sdk) => {
  const counter = sdk.Result.unwrap(await sdk.plugin(DeliveryCounter).instance())
  counter.add(3)
  return counter
}) satisfies Script
export const shortCircuit = ((sdk) => sdk.Result.gen(async function* () {
  const selected = sdk.plugin(DeliveryCounter)
  yield* sdk.Result.await(selected.config.patch({ set: { count: 999 } }, { expectedManagedRevision: 'stale revision' }))
  const counter = yield* sdk.Result.await(selected.instance())
  counter.add(1000)
  return sdk.Result.ok(counter.count)
})) satisfies Script
`,
		)
		const artifact = await compileScript({ file: source })
		expect(artifact.code).not.toContain('class DeliveryCounter')
		await host.start()
		await host.startNode(DeliveryCounter.nodeAddress())
		owner = createNodeScriptOwner({ ctx: host.ctx })
		const target = createScriptControlTarget({
			executor: owner.executor,
			subject: 'control-delivery',
			assertAuthorized() {},
			describe: () => ({ capabilities: ['plugin.instance'] }),
		})
		const request = { runId: 'generated-control-operation', code: artifact }
		const receipt = {
			protocol: SCRIPT_PROTOCOL,
			instanceId: owner.instanceId,
			runId: request.runId,
			requestHash: await scriptRequestHash(request),
		}
		expect(
			await target.submit({
				protocol: receipt.protocol,
				instanceId: receipt.instanceId,
				...request,
			}),
		).toMatchObject({ ok: true, value: { requestHash: receipt.requestHash } })
		expect(await owner.executor.settled(receipt.runId, 'control-delivery')).toMatchObject({
			state: 'succeeded',
			value: {
				status: 'ok',
				value: {
					changed: { application: 'applied', config: { count: 12 } },
					added: 17,
					observed: 17,
				},
			},
		})
		expect(
			await target.result({
				protocol: receipt.protocol,
				instanceId: receipt.instanceId,
				runId: receipt.runId,
			}),
		).toMatchObject({ ok: true, value: { state: 'succeeded' } })
		expect(
			await target.submit({
				protocol: receipt.protocol,
				instanceId: receipt.instanceId,
				...request,
			}),
		).toMatchObject({ ok: true, value: { state: 'succeeded' } })
		expect(requirePluginService(host.ctx).getInstance(DeliveryCounter.nodeAddress())).toMatchObject(
			{ count: 17 },
		)
		expect(await host.config.get(DeliveryCounter.nodeAddress())).toMatchObject({
			config: { count: 12 },
			application: 'applied',
		})
		const failureArtifact = await compileScript({ file: source, exportName: 'encodeFailure' })
		await target.submit({
			protocol: receipt.protocol,
			instanceId: receipt.instanceId,
			runId: 'generated-encode-failure',
			code: failureArtifact,
		})
		expect(
			await owner.executor.settled('generated-encode-failure', 'control-delivery'),
		).toMatchObject({
			state: 'failed',
			phase: 'encode',
			error: { code: 'result_not_serializable' },
		})
		expect(requirePluginService(host.ctx).getInstance(DeliveryCounter.nodeAddress())).toMatchObject(
			{ count: 20 },
		)
		const shortCircuit = await compileScript({ file: source, exportName: 'shortCircuit' })
		await target.submit({
			protocol: receipt.protocol,
			instanceId: receipt.instanceId,
			runId: 'generated-short-circuit',
			code: shortCircuit,
		})
		expect(
			await owner.executor.settled('generated-short-circuit', 'control-delivery'),
		).toMatchObject({
			state: 'succeeded',
			value: { status: 'error', error: { code: 'revision_conflict', state: 'unchanged' } },
		})
		expect(requirePluginService(host.ctx).getInstance(DeliveryCounter.nodeAddress())).toMatchObject(
			{ count: 20 },
		)
		expect(await host.config.get(DeliveryCounter.nodeAddress())).toMatchObject({
			config: { count: 12 },
			application: 'applied',
		})
	} finally {
		await owner?.close()
		await host.close()
		await rm(directory, { recursive: true, force: true })
	}
}, 120000)
