import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BasePlugin, Plugin, PluginPart, type PluginNodeAddress } from '@pluxel/core'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { SuperJSON } from 'superjson'
import * as v from 'valibot'
import { expect, it } from 'vitest'
import { createHost, envBinding, fileBinding, resolveHostApplication } from '../../src/index'
import { createResolvedHost } from '../../src/host'
import { createDocumentStorage } from '../support/document-storage'
import { renderPluginDescriptors } from '../../src/control-manifest'
import { runNodeModule } from '../support/node'
import { createWorkspace, hostPackage } from '../support/workspace'

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

it('reads all four config layers at a deployed fork and falls back to environment on reset', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-config-layers-'))
	try {
		await writeFile(
			join(root, 'deployment.json'),
			JSON.stringify({
				value: 'file',
				fileOnly: 'from-file',
			}),
		)
		const owner = DeploymentOwner.nodeAddress('deployment')
		const storage = createDocumentStorage()
		const document = SuperJSON.stringify({
			version: 4,
			plugins: [{ owner, config: { value: 'saved', savedOnly: 'from-saved' } }],
		})
		await storage.put('config.json', document)
		const resolved = await resolveHostApplication(
			() => ({
				plugins: [
					{
						plugin: DeploymentOwner,
						forks: {
							deployment: {
								config: { value: 'code', codeOnly: 'from-code' },
								configMode: 'saved-first',
								fileBindings: [
									fileBinding({ config: { schema: DeploymentConfig, path: 'deployment.json' } }),
								],
								envBindings: [
									envBinding({
										config: {
											schema: DeploymentConfig,
											mapping: { value: 'VALUE', envOnly: 'ENV_ONLY' },
										},
									}),
								],
							},
						},
					},
				],
				policy: { document: false },
				config: { document: { storage: () => storage } },
			}),
			{ root, mode: 'test', env: { VALUE: 'environment', ENV_ONLY: 'from-env' }, bindings: {} },
		)
		await using host = await createResolvedHost(resolved)
		await host.startNode(owner)
		const result = await host.config.get(owner)
		expect(result).toMatchObject({
			ok: true,
			application: 'applied',
			managedInput: { value: 'saved', savedOnly: 'from-saved' },
			config: {
				value: 'saved',
				codeOnly: 'from-code',
				fileOnly: 'from-file',
				envOnly: 'from-env',
				savedOnly: 'from-saved',
			},
		})
		expect(await storage.getText('config.json')).toBe(document)
		if (result.ok === false) throw new Error(result.message)
		await expect(
			host.config.reset(owner, [['value']], { expectedManagedRevision: result.managedRevision }),
		).resolves.toMatchObject({
			ok: true,
			config: { value: 'environment' },
			managedInput: { savedOnly: 'from-saved' },
			persistence: { status: 'confirmed' },
			sources: expect.arrayContaining([
				expect.objectContaining({ path: ['value'], kind: 'env', name: 'VALUE' }),
			]),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

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
		plugins: [
			{
				plugin: PartOwner,
				config: { part: { value: 'declared-default' } },
				forks: {
					tenant: {
						config: { part: { value: 'declared-fork' } },
						configMode: 'saved-first',
					},
				},
			},
		],
		policy: {
			document: false,
		},
		config: {
			document: { storage: () => storage },
		},
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
	await using workspace = await createWorkspace('config-layers-native')
	const { root } = workspace
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
		join(root, 'control.mjs'),
		renderPluginDescriptors(
			[nodes.later, nodes.separate].map(({ definition }) => ({
				exportName: definition.exportName,
				descriptor: {
					format: 2,
					definition,
					contracts: {
						config: `sha256:${'a'.repeat(64)}`,
						instance: `sha256:${'b'.repeat(64)}`,
					},
				},
			})),
		),
	)
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
		`import {Later,Separate} from './control.mjs';
export default ({bindings}) => ({
 sources:[{directory:'entries',include:['*.mjs']}],
 pluginNodes:[
  {definition:Later.address(),autoStart:Boolean(bindings.activate),forks:{
   east:{configMode:'declared-first',config:{value:'declared-east'}},
   absent:{deploy:false,configMode:'declared-only',config:{value:'never-materialized'}}
  }},
  {definition:Separate.address(),configMode:'declared-only',config:{value:'declared-separate'}}
 ],
 config:{mode:'saved-first',document:{storage:()=>bindings.storage}},
 policy:{document:false,modes:{autoStart:'declared-only'}}
});`,
	)
	const result = await runNodeModule(
		`
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {SuperJSON} from 'superjson';
const {runHostApplication,createHost}=await import(${JSON.stringify(new URL('dist/index.mjs', hostPackage).href)});
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
const host=await runHostApplication('app.mjs',{startup:{...options.startup,bindings:{storage,activate:true}}});
try {
 assert.equal(globalThis.configLayerModuleLoads,1);
 assert.equal(host.catalog().entries.length,2);
 assert.equal(requirePluginService(host.ctx).isRunning(nodes.later),true,'generated startup address selects the discovered implementation');
 for (const [owner,mode,value] of [[nodes.later,'saved-first','saved-Later'],[nodes.separate,'declared-only','declared-separate'],[nodes.east,'declared-first','declared-east']]) {
  const result=await host.config.get(owner);
  assert.equal(result.ok,true);assert.equal(result.mode,mode);assert.equal(result.config.value,value);
 }
 assert.equal((await host.config.get(nodes.absent)).code,'node_unavailable','config records must not create forks');
 const policy=await host.policy.get();assert.equal(policy.ok,true);assert.deepEqual(policy.managedInput,{});assert.deepEqual(policy.effective.forks,[nodes.east]);
 assert.equal(writes,0,'loading and reading must not seed managed records');
 const {Later}=await import(root+'/package/index.mjs');
 await assert.rejects(createHost({plugins:[{plugin:Later}],pluginNodes:[{definition:nodes.later.definition}]}),
  error=>error.message.includes('pluginNodes[0] duplicates plugins[0]'));
 await assert.rejects(createHost({pluginNodes:[{definition:Later,config:{value:'constructor'}}]}),/must be a Plugin definition address/);
 console.log('CONFIG_LAYERS_NATIVE_OK');
} finally {await host.close()}
`,
		15000,
	)
	expect(result.stdout.trim()).toBe('CONFIG_LAYERS_NATIVE_OK')
}, 30000)
