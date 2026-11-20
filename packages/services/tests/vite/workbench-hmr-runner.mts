import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readHostRecentUpdates } from '@pluxel/host/internal'
import {
	openWorkbenchFixture,
	workbenchDefinition,
	workbenchRenderer,
} from './workbench-fixture.mts'

const root = process.env.PLUXEL_WORKBENCH_HMR_ROOT!
await mkdir(resolve(root, 'src'), { recursive: true })
await writeFile(resolve(root, 'src/candidate.md'), '# Candidate guide\n\n::slot[status]\n')
const {
	server,
	currentHost,
	owner,
	dependent,
	backend,
	service,
	assertRunningVersion,
	eventually,
} = await openWorkbenchFixture(root)
try {
	await eventually(() => assertRunningVersion('initial'))
	const retainedPrevious = () =>
		eventually(() => {
			assert.equal(
				readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.outcome,
				'retained-previous',
			)
		})
	for (const [kind, version] of [
		['view', 'view-first'],
		['content', 'content-return'],
		['view', 'view-second'],
	] as const) {
		await writeFile(resolve(root, 'src/workbench.ts'), workbenchDefinition(kind, version))
		await eventually(() => assertRunningVersion(version))
	}
	// Renderer-only changes must rebuild the producer even though the Plugin source is untouched.
	const beforeRenderer = backend().artifacts.getCurrent(owner.definition)
	assert.ok(
		beforeRenderer,
		JSON.stringify({
			owner,
			layout: backend().registry.getLayout(owner),
			revision: backend().artifacts.revision,
		}),
	)
	await writeFile(resolve(root, 'src/renderer.ts'), workbenchRenderer('renderer-updated'))
	await eventually(async () => {
		const current = backend().artifacts.getCurrent(owner.definition)
		assert.ok(current)
		assert.notEqual(current.buildRevision, beforeRenderer.buildRevision)
		await assertRunningVersion('view-second')
	})
	await writeFile(resolve(root, 'src/workbench.ts'), 'export const UI =')
	await retainedPrevious()
	await writeFile(resolve(root, 'src/workbench.ts'), workbenchDefinition('view', 'syntax-fixed'))
	await eventually(() => assertRunningVersion('syntax-fixed'))
	const deleted = once(server.watcher, 'unlink', { signal: AbortSignal.timeout(25_000) })
	await unlink(resolve(root, 'src/workbench.ts'))
	const [deletedFile] = await deleted
	assert.equal(deletedFile, resolve(root, 'src/workbench.ts'))
	await retainedPrevious()
	await writeFile(resolve(root, 'src/workbench.ts'), workbenchDefinition('view', 'recreated'))
	await eventually(() => assertRunningVersion('recreated'))
	await writeFile(
		resolve(root, 'src/workbench.ts'),
		workbenchDefinition('view', 'init-broken', true),
	)
	await eventually(async () => {
		assert.equal(service().isRunning(owner), false)
		assert.equal(service().isRunning(dependent), false)
	})
	await writeFile(resolve(root, 'src/workbench.ts'), workbenchDefinition('content', 'recovered'))
	await eventually(() => assertRunningVersion('recovered'))
	// A candidate changes Content and introduces a required cycle in the same source event.
	// A rejected replacement must recreate the committed application and its Content tuple.
	const previousContent = backend().content.getCurrent(owner.definition)
	assert.ok(previousContent)
	const candidateSource = (
		cyclic: boolean,
	) => `${workbenchDefinition('content', 'catalog-candidate').replace("'./guide.md'", "'./candidate.md'")}
import { BasePlugin, Plugin } from '@pluxel/core'
import { Workbench } from '@pluxel/workbench'
import { Dependent } from './dependent'
@Plugin()
export class Owner extends BasePlugin {
  ${cyclic ? 'constructor(private readonly dependent: Dependent) { super() }' : ''}
  readonly version = version
  protected override init() {
    this.ctx.service(Workbench).publish(UI, { page: () => ({ load: () => ({ status: {} }) }) })
  }
}
export { Dependent } from './dependent'
`
	await writeFile(resolve(root, 'src/index.ts'), candidateSource(true))
	await eventually(() => {
		assert.equal(
			readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.outcome,
			'restored-previous',
		)
		assert.equal(
			readHostRecentUpdates(currentHost().ctx)?.latestUpdate()?.phase,
			'application-reload',
		)
	})
	await assertRunningVersion('recovered')
	assert.equal(backend().content.getCurrent(owner.definition)?.digest, previousContent.digest)
	const retainedEntry = backend().registry.getLayout(owner).entries[0]!
	assert.equal(retainedEntry.descriptor.kind, 'content')
	if (retainedEntry.descriptor.kind !== 'content') throw new Error('Expected Content')
	const retainedContent = backend().content.resolveContent(
		owner.definition,
		retainedEntry.descriptor,
	)
	assert.ok(retainedContent)
	assert.equal(JSON.stringify(retainedContent.plan.document).includes('HMR guide'), true)
	assert.equal(JSON.stringify(retainedContent.plan.document).includes('Candidate guide'), false)
	await writeFile(resolve(root, 'src/index.ts'), candidateSource(false))
	await eventually(async () => {
		await assertRunningVersion('catalog-candidate')
		assert.notEqual(backend().content.getCurrent(owner.definition)?.digest, previousContent.digest)
		const entry = backend().registry.getLayout(owner).entries[0]!
		assert.equal(entry.descriptor.kind, 'content')
		if (entry.descriptor.kind !== 'content') throw new Error('Expected Content')
		const acceptedContent = backend().content.resolveContent(owner.definition, entry.descriptor)
		assert.ok(acceptedContent)
		assert.equal(JSON.stringify(acceptedContent.plan.document).includes('Candidate guide'), true)
	})
} finally {
	await server.close()
}
