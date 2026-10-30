import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readdir, realpath, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const applicationRoot = resolve(process.env.STUDIO_APP_ROOT ?? projectRoot)
const applicationRequire = createRequire(join(applicationRoot, 'package.json'))
const load = (name) => import(pathToFileURL(applicationRequire.resolve(name)).href)
const root = await mkdtemp(join(tmpdir(), 'pluxel-studio-runtime-'))
const state = join(root, 'state')
const discoveryDirectory = join(root, 'discovery')
const evidenceDirectory = resolve(
	process.env.STUDIO_RUNTIME_OUTPUT ?? join(projectRoot, 'test-results/refactor/runtime'),
)
await mkdir(evidenceDirectory, { recursive: true })
const originalListen = Server.prototype.listen
let ipcListeners = 0
let tcpListeners = 0
let backend
let renderHost
// Include public entry evaluation, production Host startup and all requests.
Server.prototype.listen = function (...args) {
	const address = args[0]
	const path =
		typeof address === 'string'
			? address
			: address && typeof address === 'object'
				? address.path
				: undefined
	if (typeof path !== 'string') {
		tcpListeners += 1
		throw new Error('Studio opened a TCP/HTTP listener instead of local IPC')
	}
	ipcListeners += 1
	return Reflect.apply(originalListen, this, args)
}
async function runClient(instance, project, phase) {
	const child = fork(join(projectRoot, 'tests/runtime-client.mjs'), [], {
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		env: {
			...process.env,
			STUDIO_CLIENT_ENTRY: pathToFileURL(
				applicationRequire.resolve('@report-template-studio/app/client'),
			).href,
			STUDIO_TEST_CONFIG: JSON.stringify({
				discoveryDirectory,
				selectedInstanceId: instance.instanceId,
				selectedProjectRoot: project.root,
				evidenceDirectory,
				phase,
			}),
		},
	})
	let stdout = ''
	let stderr = ''
	child.stdout.on('data', (data) => {
		stdout += data
		if (stdout.length > 1024 * 1024) child.kill()
	})
	child.stderr.on('data', (data) => {
		stderr += data
		if (stderr.length > 1024 * 1024) child.kill()
	})
	const timer = setTimeout(() => child.kill(), 90000)
	let code
	try {
		code = await new Promise((accept, reject) => {
			child.once('error', reject)
			child.once('close', accept)
		})
	} finally {
		clearTimeout(timer)
	}
	await writeFile(join(evidenceDirectory, `phase-${phase}-stderr.log`), stderr)
	assert.equal(code, 0, `External Node client failed:\n${stderr}\n${stdout}`)
	const result = JSON.parse(stdout.trim().split('\n').at(-1))
	await writeFile(join(evidenceDirectory, `phase-${phase}.json`), JSON.stringify(result, null, 2))
	return result
}
try {
	const { startBackend } = await load('@report-template-studio/app/runtime')
	const { discoverStudio, connectStudio } = await load('@report-template-studio/app/client')
	const config = {
		root: state,
		assetsRoot: join(applicationRoot, 'financial-document-assets'),
		discoveryDirectory,
	}
	backend = await startBackend(config)
	// Discovery publishes the canonical root; temporary paths may contain filesystem aliases.
	const expectedStateRoot = await realpath(state)
	const instances = await discoverStudio({ discoveryDirectory })
	assert.equal(instances.length, 1)
	const instance = instances.find((item) => relative(expectedStateRoot, item.root) === '')
	assert.ok(instance, 'Select the explicitly requested application state root')
	assert.equal(Object.hasOwn(instance, 'token'), false)
	await assert.rejects(startBackend(config), { code: 'ROOT_IN_USE' })
	const project = await backend.api.createProject({ name: 'Production external Node workspace' })
	const tree = await backend.api.getTree({ projectId: project.id })
	assert.equal(tree.documents.length, 5)
	assert.ok(tree.entries.some((entry) => entry.path.endsWith('/data.json')))
	const providers = await backend.api.providers()
	assert.ok(providers.providers.length > 10)
	const company = providers.providers.find((provider) => provider.id === 'company-proxy')
	assert.equal(company.api, 'openai-responses')
	assert.equal(company.model, 'deepseek-flash')
	assert.equal(company.imageInput, true)
	const first = await runClient(instance, project, 1)
	const firstPreview = await backend.api.getPreview({
		...first.target,
		revision: first.retained.revision,
	})
	assert.ok(firstPreview.preview.data instanceof Uint8Array)
	const second = await runClient(instance, project, 2)
	const secondPreview = await backend.api.getPreview({
		...second.target,
		revision: second.retained.revision,
	})
	assert.equal(
		firstPreview.preview.sessionId,
		secondPreview.preview.sessionId,
		'Independent processes/disconnects reuse the retained native session',
	)
	assert.ok(secondPreview.preview.revision > firstPreview.preview.revision)
	assert.notEqual(first.compiled.sourceRevision, second.compiled.sourceRevision)
	assert.notEqual(first.compiled.revision, second.compiled.revision)
	const updatedTree = await backend.api.getTree({ projectId: project.id })
	for (const point of secondPreview.preview.navigation.points) {
		assert.equal(
			secondPreview.sourceVersions[point.path],
			updatedTree.entries.find((entry) => entry.path === point.path)?.version,
		)
	}
	const archive = await backend.api.exportWorkspaceFile({ projectId: project.id })
	const archiveBytes = await readFile(archive.path)
	assert.equal(archiveBytes.subarray(0, 4).toString('hex'), '504b0304')
	const external = await connectStudio(instance)
	await assert.rejects(
		async () =>
			await external.api.getPreview({ ...second.target, revision: second.retained.revision }),
	)
	const localApi = backend.api
	await backend.close()
	backend = undefined
	await assert.rejects(localApi.listProjects(), { code: 'BACKEND_UNAVAILABLE' })
	await assert.rejects(async () => await external.api.listProjects())
	external.disconnect()
	assert.deepEqual(await discoverStudio({ discoveryDirectory }), [])
	const closedState = await readdir(state)
	assert.ok(!closedState.some((name) => name.startsWith('.studio-host')))
	for (const artifact of [...first.artifacts, first.crop, first.pdf, archive]) {
		const bytes = await readFile(artifact.path)
		assert.equal(bytes.byteLength, artifact.byteLength, 'Shutdown retains published artifacts')
	}
	backend = await startBackend(config)
	const restartedInstances = await discoverStudio({ discoveryDirectory })
	const restarted = restartedInstances.find((item) => relative(expectedStateRoot, item.root) === '')
	assert.ok(restarted)
	assert.notEqual(restarted.instanceId, instance.instanceId)
	await assert.rejects(connectStudio(instance), { code: 'INSTANCE_CHANGED' })
	const restartedProjects = await backend.api.listProjects()
	assert.ok(restartedProjects.some((item) => item.id === project.id))
	const restartedInput = await backend.api.getInput(first.target)
	assert.deepEqual(restartedInput.data, {})
	const afterRestart = await backend.api.compile({ clientRevision: 0, ...first.target, data: {} })
	assert.notEqual(afterRestart.revision, first.compiled.revision)
	await assert.rejects(
		backend.api.renderPage({ ...first.target, revision: first.compiled.revision, page: 1 }),
		{ code: 'REVISION_CONFLICT' },
	)
	await backend.api.forgetProject({ projectId: project.id })
	for (const artifact of [...first.artifacts, first.crop, first.pdf, archive]) {
		const bytes = await readFile(artifact.path)
		assert.equal(
			bytes.byteLength,
			artifact.byteLength,
			'Restart and forget retain published artifacts',
		)
	}
	const workspaceConfig = await readFile(join(project.root, 'studio.json'), 'utf8')
	assert.equal(workspaceConfig.length > 0, true, 'Forget leaves the user workspace on disk')

	// Native worker and font artifacts resolve from the application being shipped.
	// This existing production check also runs with the Windows packaged artifact.
	const { createHost } = await load('@pluxel/host')
	const coreManifest = applicationRequire.resolve('@pluxel/core/package.json')
	const corePackage = JSON.parse(await readFile(coreManifest, 'utf8'))
	const { pluginNodeAddressOf } = await import(
		new URL(corePackage.exports['.'].import, pathToFileURL(coreManifest)).href
	)
	const { requirePluginService } = await import(
		new URL(corePackage.exports['./internal'].import, pathToFileURL(coreManifest)).href
	)
	const { FontsPlugin } = await load('@pluxel/plugin-fonts')
	const { TypstPlugin } = await load('@pluxel/plugin-typst')
	const { nodeModules } = await load('@pluxel/services/node')
	const probeRoot = join(root, 'native-page-probe')
	await mkdir(probeRoot)
	await writeFile(
		join(probeRoot, 'main.typ'),
		'#set page(width: 240pt, height: 300pt, margin: 20pt)\n= Opening\n$ integral_0^1 x^2 dif x = 1/3 $\n#pagebreak()\n= Continuation\nLast page.',
	)
	renderHost = await createHost({
		plugins: [FontsPlugin, TypstPlugin],
		services: [
			nodeModules({
				root: join(
					dirname(applicationRequire.resolve('@pluxel/plugin-typst/package.json')),
					'dist/artifacts/node',
				),
			}),
		],
		state: { initial: { autoStart: [pluginNodeAddressOf(TypstPlugin)] } },
	})
	const report = await renderHost.start()
	assert.equal(report.reconciliation.length, 0)
	assert.equal(report.core.status, 'committed')
	assert.equal(report.core.summary.lifecycleReport.ok, true)
	const typst = requirePluginService(renderHost.ctx).getInstance(pluginNodeAddressOf(TypstPlugin))
	assert.ok(typst)
	{
		await using session = await typst.open({ root: probeRoot, entry: 'main.typ' })
		const document = await session.update({ files: {} })
		assert.equal(document.preview.navigation.pages.length, 2)
		for (const page of [1, 2]) {
			const image = await session.renderPage({ revision: document.revision, page, scale: 2 })
			const bytes = Buffer.from(image.data)
			assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
			assert.equal(bytes.readUInt32BE(16), 480)
			assert.equal(bytes.readUInt32BE(20), 600)
		}
		const crop = await session.renderPage({
			revision: document.revision,
			page: 1,
			scale: 2,
			region: { x: 20, y: 20, width: 100, height: 80 },
		})
		assert.equal(crop.width, 200)
		assert.equal(crop.height, 160)
		await session.update({ files: {} })
		await assert.rejects(session.renderPage({ revision: document.revision, page: 1 }), {
			code: 'STALE_REVISION',
		})
	}
	await renderHost.close()
	renderHost = undefined
	await backend.close()
	backend = undefined
	assert.deepEqual(await discoverStudio({ discoveryDirectory }), [])
	const finalState = await readdir(state)
	assert.ok(!finalState.some((name) => name.startsWith('.studio-host')))
	assert.equal(tcpListeners, 0)
	assert.equal(ipcListeners, 2)
	const remainingResources = process.getActiveResourcesInfo()
	assert.ok(
		!remainingResources.some((name) => /MessagePort|Worker|ServerWrap/.test(name)),
		'No compiler worker or IPC listener remains after Host shutdown',
	)
	const summary = {
		applicationRoot,
		clientEntry: applicationRequire.resolve('@report-template-studio/app/client'),
		platform: process.platform,
		externalProcesses: 2,
		projects: 1,
		documents: tree.documents.length,
		sessionId: secondPreview.preview.sessionId,
		nativeRevisions: [firstPreview.preview.revision, secondPreview.preview.revision],
		navigationPoints: secondPreview.preview.navigation.points.length,
		pages: second.compiled.pageCount,
		externalPngReads: 8,
		pdfBytes: second.pdf.byteLength,
		vectorBytes: secondPreview.preview.data.byteLength,
		coldMs: first.compiled.elapsedMs,
		hotMs: second.compiled.elapsedMs,
		tcpListeners,
		ipcListeners,
		rootOwnershipEnforced: true,
		restartArtifactsRetained: true,
		forgetUserFilesRetained: true,
		discoveryCleaned: true,
		nativePageProbe: true,
		clientImportIsolation: true,
		remainingResources,
	}
	await writeFile(join(evidenceDirectory, 'summary.json'), JSON.stringify(summary, null, 2))
	console.log(JSON.stringify(summary))
} finally {
	try {
		await Promise.all([renderHost?.close(), backend?.close()])
	} finally {
		Server.prototype.listen = originalListen
		await rm(root, { recursive: true, force: true })
	}
}
