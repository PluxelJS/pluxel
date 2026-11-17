import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BasePlugin, Plugin, PluginPart, type PluginNodeAddress } from '@pluxel/core'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { SuperJSON } from 'superjson'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { createHost, envBinding, fileBinding, resolveHostApplication } from '../src/index'
import { createDocumentStorage } from './helpers/document-storage'

const DeploymentConfig = v.object({
	value: v.string(),
	codeOnly: v.string(),
	fileOnly: v.string(),
	envOnly: v.string(),
	savedOnly: v.optional(v.string()),
})

@Plugin({ forkable: true })
class DeploymentOwner extends BasePlugin {
	readonly config = this.configs.use(DeploymentConfig)
}

it.each(['declared-only', 'declared-first', 'saved-first'] as const)(
	'composes a real fork from code, file, environment and saved input using %s',
	async (mode) => {
		const root = await mkdtemp(join(tmpdir(), 'pluxel-config-layers-'))
		try {
			await writeFile(
				join(root, 'deployment.json'),
				JSON.stringify({ value: 'file', fileOnly: 'from-file' }),
			)
			const owner = DeploymentOwner.nodeAddress('deployment')
			const storage = createDocumentStorage()
			const document = SuperJSON.stringify({
				version: 4,
				plugins: [{ owner, config: { value: 'saved', savedOnly: 'from-saved' } }],
			})
			await storage.put('config.json', document)
			let writes = 0
			const resolved = await resolveHostApplication(
				() => ({
					plugins: [DeploymentOwner],
					policy: { forks: [owner] },
					config: {
						mode: 'declared-only',
						records: [{ owner, mode, config: { value: 'code', codeOnly: 'from-code' } }],
					},
					fileBindings: [
						fileBinding(owner, { config: { schema: DeploymentConfig, path: 'deployment.json' } }),
					],
					envBindings: [
						envBinding(owner, {
							config: {
								schema: DeploymentConfig,
								mapping: { value: 'VALUE', envOnly: 'ENV_ONLY' },
							},
						}),
					],
					runtime: {
						documents: {
							state: false,
							config: {
								storage: () => ({
									...storage,
									async put(key, value) {
										writes++
										await storage.put(key, value)
									},
								}),
							},
						},
					},
				}),
				{ root, mode: 'test', env: { VALUE: 'environment', ENV_ONLY: 'from-env' }, bindings: {} },
			)
			await using host = await createHost({
				plugins: resolved.plugins,
				policy: resolved.policy,
				config: resolved.config,
				runtime: resolved.runtime,
			})
			await host.startNode(owner)
			const result = await host.config.get(owner)
			expect(result).toMatchObject({
				ok: true,
				mode,
				application: 'applied',
				persistence: { status: 'unchanged' },
				managedInput: { value: 'saved', savedOnly: 'from-saved' },
				config: {
					value: mode === 'saved-first' ? 'saved' : 'environment',
					codeOnly: 'from-code',
					fileOnly: 'from-file',
					envOnly: 'from-env',
					...(mode === 'declared-only' ? {} : { savedOnly: 'from-saved' }),
				},
			})
			if (result.ok === false) throw new Error(result.message)
			expect(Object.hasOwn(result.config, 'savedOnly')).toBe(mode !== 'declared-only')
			expect(result.sources).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: ['codeOnly'], kind: 'declaration' }),
					expect.objectContaining({ path: ['fileOnly'], kind: 'file', name: 'deployment.json' }),
					expect.objectContaining({ path: ['envOnly'], kind: 'env', name: 'ENV_ONLY' }),
					expect.objectContaining({
						path: ['value'],
						kind: mode === 'saved-first' ? 'saved' : 'env',
					}),
				]),
			)
			expect(writes).toBe(0)
			expect(await storage.getText('config.json')).toBe(document)
			await expect(
				host.config.reset(owner, [['value']], {
					expectedManagedRevision: result.managedRevision,
				}),
			).resolves.toMatchObject({
				ok: true,
				config: { value: 'environment' },
				managedInput: { savedOnly: 'from-saved' },
				persistence: { status: 'confirmed', retention: 'unknown' },
				sources: expect.arrayContaining([
					expect.objectContaining({ path: ['value'], kind: 'env', name: 'VALUE' }),
				]),
			})
			expect(writes).toBe(1)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

const PartConfig = v.object({ value: v.string(), retained: v.optional(v.number()) })
const RootConfig = v.object({ title: v.optional(v.string(), 'schema-default') })

class ConfiguredPart extends PluginPart<PartOwner> {
	readonly config = this.configs.use(PartConfig)
}

@Plugin({ forkable: true })
class PartOwner extends BasePlugin {
	readonly part = this.parts.use(ConfiguredPart)
	readonly config = this.configs.use(RootConfig)
}

it('selects and validates Part subtrees within each default or fork owner record', async () => {
	const owner = PartOwner.nodeAddress()
	const fork = PartOwner.nodeAddress('tenant')
	const storage = createDocumentStorage()
	await storage.put(
		'config.json',
		SuperJSON.stringify({
			version: 4,
			plugins: [owner, fork].map((node) => ({
				owner: node,
				config: { part: { value: 'saved', retained: 7 } },
			})),
		}),
	)
	await using host = await createHost({
		plugins: [PartOwner],
		policy: { forks: [fork] },
		config: {
			records: [
				{ owner: PartOwner, config: { part: { value: 'declared-default' } } },
				{ owner: fork, mode: 'saved-first', config: { part: { value: 'declared-fork' } } },
			],
		},
		runtime: { documents: { state: false, config: { storage: () => storage } } },
	})
	await host.startNode(owner)
	await host.startNode(fork)
	expect(await host.config.get(owner)).toMatchObject({
		ok: true,
		mode: 'declared-first',
		application: 'applied',
		config: { title: 'schema-default', part: { value: 'declared-default', retained: 7 } },
	})
	const before = await host.config.get(fork)
	expect(before).toMatchObject({
		ok: true,
		mode: 'saved-first',
		application: 'applied',
		config: { title: 'schema-default', part: { value: 'saved', retained: 7 } },
	})
	await expect(host.config.patch(fork, { set: { part: { value: 42 } } })).resolves.toMatchObject({
		ok: false,
		code: 'validation_failed',
		effectiveInput: { part: { value: 42, retained: 7 } },
	})
	expect(await host.config.get(fork)).toEqual(before)
	await expect(host.config.reset(fork, [['part', 'value']])).resolves.toMatchObject({
		ok: true,
		managedInput: { part: { retained: 7 } },
		config: { title: 'schema-default', part: { value: 'declared-fork', retained: 7 } },
	})
	expect(await host.config.get(owner)).toMatchObject({
		ok: true,
		managedInput: { part: { value: 'saved', retained: 7 } },
		config: { title: 'schema-default', part: { value: 'declared-default', retained: 7 } },
	})
})

function packageNode(exportName: string, forkId?: string): PluginNodeAddress {
	return {
		definition: {
			entry: { kind: 'package-root', packageName: '@fixture/config-layers' },
			exportName,
		},
		...(forkId === undefined
			? { variant: 'default' as const }
			: { variant: 'fork' as const, forkId }),
	}
}

it('applies global and exact-node modes to a later directory publication with multiple package exports', async () => {
	const root = await mkdtemp(fileURLToPath(new URL('./.config-layers-native-', import.meta.url)))
	try {
		await mkdir(join(root, 'entries'))
		await mkdir(join(root, 'package'))
		await writeFile(
			join(root, 'package/package.json'),
			JSON.stringify({ name: '@fixture/config-layers', version: '1.0.0', type: 'module' }),
		)
		const nodes = {
			later: packageNode('Later'),
			separate: packageNode('Separate'),
			east: packageNode('Later', 'east'),
			absent: packageNode('Later', 'absent'),
		}
		await writeFile(
			join(root, 'package/index.mjs'),
			`import { BasePlugin, Plugin } from '@pluxel/core';
import { __setPluginDefinition, __setPluginConfig } from '@pluxel/core/toolchain';
import * as v from 'valibot';
globalThis.configLayerModuleLoads = (globalThis.configLayerModuleLoads ?? 0) + 1;
const schema = v.object({value:v.string()});
class Later extends BasePlugin { config = this.configs.use(schema) }
class Separate extends BasePlugin { config = this.configs.use(schema) }
for (const [plugin, definition] of [[Later,${JSON.stringify(nodes.later.definition)}],[Separate,${JSON.stringify(nodes.separate.definition)}]]) {
 Plugin({forkable:true})(plugin);
 __setPluginConfig(plugin,{abiVersion:${PLUGIN_LOWERING_ABI_VERSION},fieldName:'config',schema});
 __setPluginDefinition(plugin,{abiVersion:${PLUGIN_LOWERING_ABI_VERSION},kind:'plugin',definition});
}
export { Later, Separate };
`,
		)
		await writeFile(
			join(root, 'app.mjs'),
			`export default ({bindings}) => ({
 plugins:[], sources:[{kind:'directory',path:'entries',include:['*.mjs']}],
 policy:{forks:[${JSON.stringify(nodes.east)}],autoStart:[],mode:{autoStart:'declared-only'}},
 config:{mode:'saved-first',records:[
  {owner:${JSON.stringify(nodes.separate)},mode:'declared-only',config:{value:'declared-separate'}},
  {owner:${JSON.stringify(nodes.east)},mode:'declared-first',config:{value:'declared-east'}},
  {owner:${JSON.stringify(nodes.absent)},mode:'declared-only',config:{value:'never-materialized'}}
 ]},
 runtime:{documents:{state:false,config:{storage:()=>bindings.storage}}}
});`,
		)
		const result = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {SuperJSON} from 'superjson';
const {runHostApplication,createHost}=await import(${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)});
const {requirePluginService}=await import('@pluxel/core/internal');
const root=${JSON.stringify(root)},nodes=${JSON.stringify(nodes)};
const document=SuperJSON.stringify({version:4,plugins:Object.values(nodes).map(owner=>({owner,config:{value:'saved-'+(owner.variant==='fork'?owner.forkId:owner.definition.exportName)}}))});
let writes=0;
const storage={async getText(){return document},async put(){writes++},async stat(){return {}}};
const options={startup:{root,mode:'production',env:{},bindings:{storage}}};
const initial=await runHostApplication('app.mjs',options);
try {
 assert.equal(initial.catalog().entries.length,0);
 assert.equal(globalThis.configLayerModuleLoads,undefined);
 assert.equal((await initial.config.get(nodes.east)).code,'node_unavailable');
 await writeFile(root+'/entries/published.mjs',"export {Later,Separate} from '../package/index.mjs'");
 assert.equal(initial.catalog().entries.length,0,'native source publications take effect at the next Host');
} finally {await initial.close()}
const host=await runHostApplication('app.mjs',options);
try {
 assert.equal(globalThis.configLayerModuleLoads,1);
 assert.equal(host.catalog().entries.length,2);
 for (const [owner,mode,value] of [[nodes.later,'saved-first','saved-Later'],[nodes.separate,'declared-only','declared-separate'],[nodes.east,'declared-first','declared-east']]) {
  const result=await host.config.get(owner);
  assert.equal(result.ok,true);assert.equal(result.mode,mode);assert.equal(result.config.value,value);
 }
 assert.equal((await host.config.get(nodes.absent)).code,'node_unavailable','config records must not create forks');
 const policy=await host.policy.get();assert.equal(policy.ok,true);assert.deepEqual(policy.managedInput,{});assert.deepEqual(policy.effective.forks,[nodes.east]);
 await host.startNode(nodes.later);assert.equal(requirePluginService(host.ctx).isRunning(nodes.later),true);
 await host.stopNode(nodes.later);assert.equal(requirePluginService(host.ctx).isRunning(nodes.later),false);
 assert.deepEqual((await host.policy.get()).managedInput,{},'declared-only does not persist session intent');
 assert.equal(writes,0,'loading and reading must not seed managed records');
 const {Later}=await import(root+'/package/index.mjs');
 await assert.rejects(createHost({plugins:[Later],config:{records:[{owner:Later,config:{value:'constructor'}},{owner:nodes.later,mode:'saved-first'}]}}),/duplicates a Plugin node owner/);
 console.log('CONFIG_LAYERS_NATIVE_OK');
} finally {await host.close()}
`,
			],
			{ timeout: 15000 },
		)
		expect(result.stdout.trim()).toBe('CONFIG_LAYERS_NATIVE_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30000)
