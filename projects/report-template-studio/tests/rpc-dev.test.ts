import { expect, it } from 'vitest'
import { cp, mkdtemp, rm, symlink, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rolldown } from 'rolldown'

it('official host-vite replacement withdraws old capabilities and preserves document input and artifact bytes', async () => {
	const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
	const directory = await mkdtemp(join(tmpdir(), 'studio-rpc-dev-'))
	const appRoot = join(directory, 'application')
	const evidenceDirectory = join(projectRoot, 'test-results/refactor')
	try {
		await mkdir(appRoot)
		await cp(join(projectRoot, 'package.json'), join(appRoot, 'package.json'))
		for (const name of ['backend', 'shared', 'rpc', 'client'])
			await cp(join(projectRoot, 'src', name), join(appRoot, 'src', name), { recursive: true })
		for (const root of [directory, appRoot])
			await symlink(
				join(projectRoot, 'node_modules'),
				join(root, 'node_modules'),
				process.platform === 'win32' ? 'junction' : 'dir',
			)
		await symlink(
			join(projectRoot, 'dist'),
			join(appRoot, 'dist'),
			process.platform === 'win32' ? 'junction' : 'dir',
		)
		// A separate Node process avoids inheriting Vitest's framework source execution realm.
		// These are the same carrier/client entry files, with ordinary installed framework imports.
		const bundle = await rolldown({
			input: {
				dev: join(projectRoot, 'src/backend/dev.ts'),
				client: join(projectRoot, 'src/client/index.ts'),
				'message-port': join(projectRoot, 'src/rpc/message-port.ts'),
			},
			external: (id) => !id.startsWith('.') && !id.startsWith('/'),
		})
		try {
			await bundle.write({
				dir: directory,
				format: 'esm',
				entryFileNames: '[name].mjs',
				chunkFileNames: 'shared-[hash].mjs',
			})
		} finally {
			await bundle.close()
		}
		const driver = `
import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MessageChannel } from 'node:worker_threads'
import { join } from 'node:path'
import { startDevBackend } from './dev.mjs'
import { connectStudio, discoverStudio } from './client.mjs'
import { createNativeDesktopClient } from './message-port.mjs'
const appRoot = ${JSON.stringify(appRoot)}
const evidenceDirectory = ${JSON.stringify(evidenceDirectory)}
const discoveryDirectory = ${JSON.stringify(join(directory, 'instances'))}
const config = ${JSON.stringify({ root: join(directory, 'profile'), assetsRoot: join(projectRoot, 'financial-document-assets'), discoveryDirectory: join(directory, 'instances') })}
async function until(check) {
  const end = Date.now() + 30000
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('Official Host replacement did not become observable')
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const compilationState = result => ({revision:result.revision, sourceRevision:result.sourceRevision, data:result.data, pageCount:result.pageCount})
let backend, connection, nativeClient, detachNative
try {
  backend = await startDevBackend(config, appRoot)
  const instances = await discoverStudio({discoveryDirectory})
  assert.equal(instances.length, 1)
  const instance = instances[0]
  connection = await connectStudio(instance)
  const project = await connection.api.createProject({name:'Generation continuity'})
  const target = {projectId:project.id, entry:'报表/季度经营分析/季度经营分析.ts'}
  const storedData = {revenue:1300000}
  const explicitData = {revenue:1400000}
  const initialInput = await connection.api.getInput(target)
  await connection.api.setInput({...target, data:storedData, expectedVersion:initialInput.storageVersion})
  const beforeInput = await connection.api.getInput(target)
  assert.deepEqual(beforeInput.data, storedData)
  const beforeCompiled = await connection.api.compile({ clientRevision: 0,...target, data:explicitData})
  assert.ok(beforeCompiled.pageCount > 2, 'The real seeded report must produce multiple pages')
  const png = await connection.api.renderPage({...target, revision:beforeCompiled.revision, page:2, scale:1})
  const pdf = await connection.api.exportPdf({...target, revision:beforeCompiled.revision})
  await mkdir(evidenceDirectory, {recursive:true})
  const beforeArtifacts = []
  for (const artifact of [png, pdf]) {
    const bytes = await readFile(artifact.path)
    assert.equal(bytes.byteLength, artifact.byteLength)
    assert.equal(bytes.subarray(0, artifact.kind === 'png' ? 8 : 5).toString('hex'), artifact.kind === 'png' ? '89504e470d0a1a0a' : '255044462d')
    const evidencePath = join(evidenceDirectory, 'hmr-before.' + artifact.kind)
    await copyFile(artifact.path, evidencePath)
    beforeArtifacts.push({metadata:artifact, bytes, sha256:sha256(bytes), evidencePath})
  }
  assert.deepEqual(await connection.api.getInput(target), beforeInput, 'Explicit compilation must preserve stored input')
  const before = {
    instanceId:instance.instanceId, root:instance.root, project, input:beforeInput,
    compilation:compilationState(beforeCompiled),
    artifacts:beforeArtifacts.map(({bytes, ...artifact}) => artifact),
  }
  const oldLocalApi = backend.api
  const entry = join(appRoot, 'src/backend/application.ts')
  const source = await readFile(entry, 'utf8')
  await writeFile(entry, source.replace("name: 'report-template-studio'", "name: 'report-template-studio-generation-two'"))
  await until(async () => { try { await connection.api.listProjects(); return false } catch { return true } })
  await assert.rejects(oldLocalApi.listProjects(), {code:'BACKEND_UNAVAILABLE'})
  connection.disconnect()
  await until(async () => {
    const current = await discoverStudio({discoveryDirectory})
    if (!current.some(candidate => candidate.instanceId === instance.instanceId)) return false
    try {
      const client = await connectStudio(instance)
      try { return (await client.api.listProjects()).some(item => item.id === project.id) } finally { client.disconnect() }
    } catch { return false }
  })
  const afterInstance = (await discoverStudio({discoveryDirectory})).find(candidate => candidate.instanceId === instance.instanceId)
  assert.ok(afterInstance)
  assert.equal(afterInstance.root, instance.root)
  connection = await connectStudio(afterInstance)
  const afterProject = await connection.api.getProject({projectId:project.id})
  const afterInput = await connection.api.getInput(target)
  assert.deepEqual(afterProject, project)
  assert.deepEqual(afterInput, beforeInput)
  await assert.rejects(async () => await connection.api.renderPage({...target, revision:beforeCompiled.revision, page:2}), {code:'REVISION_CONFLICT'})
  // A dedicated trusted port exercises the new Plugin's production ArtifactStore resolver.
  // This capability is never attached to the public external socket.
  const ports = new MessageChannel()
  detachNative = backend.connectDesktopPort(ports.port1, {native:true})
  nativeClient = createNativeDesktopClient(ports.port2)
  const afterArtifacts = []
  for (const previous of beforeArtifacts) {
    const metadata = await nativeClient.api.resolveArtifact({id:previous.metadata.id})
    assert.deepEqual(metadata, previous.metadata, 'The replacement host must recover retained artifact metadata')
    const bytes = await readFile(metadata.path)
    assert.deepEqual(bytes, previous.bytes, 'Published artifact bytes must survive Host replacement unchanged')
    const evidencePath = join(evidenceDirectory, 'hmr-after.' + metadata.kind)
    await copyFile(metadata.path, evidencePath)
    afterArtifacts.push({metadata, sha256:sha256(bytes), evidencePath})
  }
  const afterCompiled = await connection.api.compile({ clientRevision: 0,...target, data:explicitData})
  assert.notEqual(afterCompiled.revision, beforeCompiled.revision)
  assert.equal(afterCompiled.sourceRevision, beforeCompiled.sourceRevision)
  assert.equal(afterCompiled.pageCount, beforeCompiled.pageCount)
  assert.deepEqual(afterCompiled.data, beforeCompiled.data)
  assert.deepEqual(await connection.api.getInput(target), beforeInput)
  const after = {
    instanceId:afterInstance.instanceId, root:afterInstance.root, project:afterProject, input:afterInput,
    compilation:compilationState(afterCompiled), artifacts:afterArtifacts,
  }
  const evidence = {
    generatedAt:new Date().toISOString(), trigger:'Official host-vite application.name source edit',
    transport:'Authenticated AF_UNIX socket plus dedicated trusted Node MessagePort for artifact metadata recovery',
    before, after,
    checks:{generationWithdrawn:true, projectDataPreserved:true, storedInputPreserved:true, artifactMetadataRecovered:true, artifactBytesPreserved:true, oldDocumentRevisionRejected:true, newDocumentCompiled:true},
  }
  await writeFile(join(evidenceDirectory, 'hmr-generation.json'), JSON.stringify(evidence, null, 2) + '\\n')
  console.log(JSON.stringify(evidence.checks))
} finally { nativeClient?.disconnect(); detachNative?.(); connection?.disconnect(); await backend?.close() }
`
		await writeFile(join(directory, 'driver.mjs'), driver)
		const result = await promisify(execFile)(process.execPath, [join(directory, 'driver.mjs')], {
			cwd: appRoot,
			timeout: 55000,
			maxBuffer: 128 * 1024,
			env: { ...process.env, NODE_OPTIONS: '' },
		})
		expect(result.stdout).toContain('"generationWithdrawn":true')
		expect(result.stdout).toContain('"projectDataPreserved":true')
		const evidence = JSON.parse(
			await readFile(join(evidenceDirectory, 'hmr-generation.json'), 'utf8'),
		)
		expect(evidence.checks).toMatchObject({
			storedInputPreserved: true,
			artifactMetadataRecovered: true,
			artifactBytesPreserved: true,
			newDocumentCompiled: true,
		})
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}, 60000)
