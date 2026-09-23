import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'pluxel-independent-workbench-'))
const loaded = []
const hook = registerHooks({
	load(url, context, next) {
		loaded.push(url)
		return next(url, context)
	},
})
const { vitePreset } = await import('@pluxel/services/vite')
const { workbenchArtifacts } = await import('../dist/dev.mjs')
const { requireWorkbench, createWorkbenchArtifactHandler } = await import('../dist/server.mjs')
const { readHostRecentUpdates } = await import('@pluxel/host/internal')
const diagnostics = []
let server, instance
const until = async (predicate) => {
	const deadline = Date.now() + 20000
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error(
				'Workbench fixture timed out ' +
					JSON.stringify(
						instance
							? {
									catalog: instance.catalog(),
									layout: requireWorkbench(instance.ctx).registry.getLayout({
										definition: instance.catalog().entries[0].address,
										variant: 'default',
									}),
								}
							: null,
					),
			)
		await delay(40)
	}
}
const write = (name, source) => writeFile(join(root, name), source)
try {
	await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
	await mkdir(join(root, 'node_modules/@mantine'), { recursive: true })
	await mkdir(join(root, 'node_modules/@module-federation'), { recursive: true })
	await symlink(
		join(workspace, 'packages/workbench/node_modules/@module-federation/bridge-react'),
		join(root, 'node_modules/@module-federation/bridge-react'),
		'dir',
	)
	for (const name of ['core', 'host', 'workbench', 'services'])
		await symlink(
			join(workspace, 'packages', name),
			join(root, 'node_modules/@pluxel', name),
			'dir',
		)
	for (const name of ['react', 'react-dom', '@mantine/core', '@mantine/hooks'])
		await symlink(
			join(workspace, 'packages/workbench/node_modules', name),
			join(root, 'node_modules', name),
			'dir',
		)
	await write(
		'package.json',
		JSON.stringify({
			name: '@test/independent-workbench',
			type: 'module',
			exports: { '.': './plugin.ts' },
		}),
	)
	await write('guide.md', '# First guide\n')
	await write(
		'view.ts',
		"import { useWorkbench } from '@pluxel/workbench/react';import { UI } from './definition';export default function View(){useWorkbench(UI.page);return 'first renderer'}\n",
	)
	await write(
		'definition.ts',
		`import { workbench } from '@pluxel/workbench';
export const UI = workbench.define({
 guide: workbench.content({document: workbench.markdown(import.meta.url,'./guide.md'),placement: workbench.tab({label:'Guide'})}),
 page: workbench.view({renderer:workbench.entry(import.meta.url,'./view.ts'),placement:workbench.tab({label:'Page'})})
});`,
	)
	await write(
		'plugin.ts',
		`import { BasePlugin, Plugin } from '@pluxel/core';import { Workbench } from '@pluxel/workbench';import { RpcTarget } from 'capnweb';import { UI } from './definition';
class Page extends RpcTarget {value(){return 42}}
@Plugin() export class Viewer extends BasePlugin {init(){this.ctx.require(Workbench).publish(UI,{page:()=>new Page()})}}
`,
	)
	await symlink(
		join(workspace, 'packages/workbench/node_modules/capnweb'),
		join(root, 'node_modules/capnweb'),
		'dir',
	)
	await write(
		'app.ts',
		`import { defineConfig } from '@pluxel/host';import { pluginNodeAddressOf } from '@pluxel/core';import { Viewer } from './plugin';import { workbenchService } from '@pluxel/workbench/service';import { logging } from '@pluxel/services/logging';
export default defineConfig(({bindings}) => ({plugins:[Viewer],services:[logging({
 root:{profile:'fixture'},sinks:{console:{kind:'console',format:'pretty',caller:false,timezone:'utc'},capture:{kind:'logtape',label:'test diagnostics',sink:bindings.captureLog,caller:false}},
 routes:{runtime:[{sink:'console',minLevel:'error'},{sink:'capture',minLevel:'error'}],plugins:[],debug:[],meta:[]}
}),workbenchService()],state:{initial:{autoStart:[pluginNodeAddressOf(Viewer)]}}}))`,
	)
	server = await createServer({
		root,
		configFile: false,
		logLevel: 'silent',
		server: { port: 0, host: '127.0.0.1' },
		plugins: [
			vitePreset({
				entry: 'app.ts',
				bindings: { captureLog: (record) => diagnostics.push(record) },
			}),
			workbenchArtifacts({ cacheDir: join(root, '.pluxel/artifacts') }),
			{
				name: 'test:borrow-host',
				api: {
					pluxelHost: {
						attach({ host: borrowedHost }) {
							instance = borrowedHost
						},
					},
				},
			},
		],
	})
	await server.listen()
	await until(
		() =>
			instance &&
			requireWorkbench(instance.ctx).registry.getLayout({
				definition: instance.catalog().entries[0].address,
				variant: 'default',
			}).entries.length === 2,
	)
	const backend = requireWorkbench(instance.ctx)
	const original = instance
	const target = instance.catalog().entries[0].address
	const address = { definition: target, variant: 'default' }
	const session = backend.createSession({ provider: 'fixture', subject: 'reader' }, () => {})
	const layout = session.target.layoutDto({ target: address })
	const guide = layout.entries.find((entry) => entry.descriptor.kind === 'content')
	assert.ok(guide)
	const opened = await session.target.openEntry({
		layoutRevision: layout.revision,
		target: address,
		descriptor: guide.descriptor,
	})
	assert.equal(opened.ok, true)
	const firstRevision = backend.artifactCoordinator.revision
	await delay(150)
	await write('guide.md', '# Updated guide\n')
	await until(() => backend.artifactCoordinator.revision > firstRevision)
	assert.equal(instance, original, 'artifact-only updates keep the same Host')
	assert.equal(session.signal.aborted, true, 'new artifact invalidates old sessions')
	await until(() =>
		backend.registry
			.getLayout({ definition: instance.catalog().entries[0].address, variant: 'default' })
			.entries.some((entry) => entry.federatedViewRef),
	)
	const firstPage = backend.registry
		.getLayout({ definition: instance.catalog().entries[0].address, variant: 'default' })
		.entries.find((entry) => entry.federatedViewRef)
	// Opening a source Plugin's RpcTarget must use the backend's native Cap'n Web identity.
	const viewSession = backend.createSession({ provider: 'fixture', subject: 'reader' }, () => {})
	const viewLayout = viewSession.target.layoutDto({ target: address })
	const view = viewLayout.entries.find((entry) => entry.federatedViewRef)
	assert.ok(view)
	const openedView = await viewSession.target.openEntry({
		layoutRevision: viewLayout.revision,
		target: address,
		descriptor: view.descriptor,
	})
	assert.equal(openedView.ok, true, JSON.stringify(openedView))
	const handler = createWorkbenchArtifactHandler(instance.ctx)
	const artifact = await handler(
		new Request(new URL(firstPage.federatedViewRef.manifestUrl, 'http://fixture')),
	)
	assert.equal(artifact.status, 200)
	const cached = await handler(
		new Request(new URL(firstPage.federatedViewRef.manifestUrl, 'http://fixture'), {
			headers: { 'if-none-match': artifact.headers.get('etag') },
		}),
	)
	assert.equal(cached.status, 304)
	const pageRevision = firstPage.federatedViewRef.buildRevision
	await write('view.ts', 'export default function Broken( {\n')
	await until(
		() => readHostRecentUpdates(instance.ctx)?.latestUpdate()?.outcome === 'retained-previous',
	)
	const rejected = readHostRecentUpdates(instance.ctx).latestUpdate()
	assert.equal(rejected.phase, 'artifacts')
	assert.match(rejected.error.message, /cannot verify renderer dependency.*view\.ts/)
	assert.equal(instance, original)
	assert.equal(
		backend.registry.getLayout(address).entries.find((entry) => entry.federatedViewRef)
			?.federatedViewRef.buildRevision,
		pageRevision,
	)
	assert.ok(
		diagnostics.some((record) =>
			record.properties.error?.message?.includes('cannot verify renderer dependency'),
		),
		'semantic HMR errors reach the selected Host logger',
	)
	// A valid semantic plan with an unavailable CSS import fails in the background producer instead.
	await write(
		'view.ts',
		"import './missing.css';import { useWorkbench } from '@pluxel/workbench/react';import { UI } from './definition';export default function View(){useWorkbench(UI.page);return 'unbuildable renderer'}\n",
	)
	await until(() =>
		backend.registry
			.getLayout(address)
			.entries.some((entry) => entry.federatedViewUnavailable?.reason === 'failed'),
	)
	const previousArtifact = await handler(
		new Request(new URL(firstPage.federatedViewRef.manifestUrl, 'http://fixture')),
	)
	assert.equal(
		previousArtifact.status,
		200,
		'accepted immutable artifacts remain readable after a failed successor',
	)
	await write(
		'view.ts',
		"import { useWorkbench } from '@pluxel/workbench/react';import { UI } from './definition';export default function View(){useWorkbench(UI.page);return 'second renderer'}\n",
	)
	await until(() =>
		backend.registry
			.getLayout({ definition: instance.catalog().entries[0].address, variant: 'default' })
			.entries.some(
				(entry) => entry.federatedViewRef?.buildRevision !== pageRevision && entry.federatedViewRef,
			),
	)
	assert.equal(instance, original)
	const lastSession = backend.createSession({ provider: 'fixture', subject: 'reader' }, () => {})
	await server.close()
	server = undefined
	assert.equal(lastSession.signal.aborted, true)
	assert.equal(
		loaded.some((url) => /packages\/runtime\/|@pluxel[+/]runtime/.test(url)),
		false,
		'independent Workbench does not load Runtime',
	)
	console.log('INDEPENDENT_WORKBENCH_VITE_OK')
} finally {
	await server?.close()
	hook.deregister()
	await rm(root, { recursive: true, force: true })
}
