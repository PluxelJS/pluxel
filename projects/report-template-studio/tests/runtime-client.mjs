import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { registerHooks } from 'node:module'

const imports = []
registerHooks({
	resolve(specifier, context, next) {
		imports.push(specifier)
		if (
			specifier === 'electron' ||
			specifier === 'node:worker_threads' ||
			/^@pluxel\/(core|host|typst|fonts|services)(?:\/|$)/.test(specifier) ||
			specifier.startsWith('@mariozechner/') ||
			['vite', 'quickjs-emscripten'].includes(specifier)
		)
			throw new Error('Client import isolation violation: ' + specifier)
		return next(specifier, context)
	},
})
// Entry is resolved from the shipped package's public export by the host test.
const { discoverStudio, connectStudio, withStudio } = await import(process.env.STUDIO_CLIENT_ENTRY)
const config = JSON.parse(process.env.STUDIO_TEST_CONFIG)
const instances = await discoverStudio({ discoveryDirectory: config.discoveryDirectory })
const instance = instances.find((item) => item.instanceId === config.selectedInstanceId)
assert.ok(instance, 'The explicitly selected live instance must be discoverable')
assert.equal(Object.hasOwn(instance, 'token'), false)
await mkdir(config.evidenceDirectory, { recursive: true })
let result
await withStudio(instance, async (studio) => {
	const projects = await studio.listProjects()
	const project = projects.find((item) => item.root === config.selectedProjectRoot)
	assert.ok(project, 'Use explicit project root selection')
	const target = { projectId: project.id, entry: '报表/季度经营分析/季度经营分析.ts' }
	if (config.phase === 2) {
		for (const path of ['报表/季度经营分析/排版.typ', target.entry, '共享/主题/财务函件.typ']) {
			const source = await studio.readFile({ projectId: project.id, path })
			await studio.writeFile({
				projectId: project.id,
				path,
				content: source.content + '\n// External Node client HMR edit\n',
				expectedVersion: source.version,
			})
		}
	}
	const compiled = await studio.compile({
		clientRevision: 0,
		...target,
		data: config.phase === 2 ? { revenue: 1400000 } : {},
	})
	assert.ok(compiled.pageCount > 2)
	assert.equal(Object.hasOwn(compiled, 'preview'), false)
	assert.equal(Object.hasOwn(compiled, 'fields'), false)
	const storedInput = await studio.getInput(target)
	assert.deepEqual(storedInput.data, {})
	const artifacts = []
	for (const page of [1, 2, compiled.pageCount]) {
		const image = await studio.renderPage({
			...target,
			revision: compiled.revision,
			page,
			scale: 1,
		})
		const bytes = await readFile(image.path)
		assert.equal(bytes.byteLength, image.byteLength)
		assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
		const copy = join(config.evidenceDirectory, `phase-${config.phase}-page-${page}.png`)
		await copyFile(image.path, copy)
		artifacts.push({
			...image,
			evidencePath: copy,
			sha256: createHash('sha256').update(bytes).digest('hex'),
		})
	}
	const crop = await studio.renderPage({
		...target,
		revision: compiled.revision,
		page: 2,
		scale: 2,
		region: { x: 50, y: 50, width: 200, height: 150 },
	})
	assert.equal(crop.width, 400)
	assert.equal(crop.height, 300)
	await copyFile(crop.path, join(config.evidenceDirectory, `phase-${config.phase}-crop.png`))
	const pdf = await studio.exportPdf({ ...target, revision: compiled.revision })
	const pdfBytes = await readFile(pdf.path)
	assert.equal(pdfBytes.subarray(0, 5).toString(), '%PDF-')
	await copyFile(pdf.path, join(config.evidenceDirectory, `phase-${config.phase}.pdf`))
	const errors = []
	for (const operation of [
		() => studio.compile({ clientRevision: 0, ...target }),
		() => studio.compile({ clientRevision: 0, ...target, data: { revenue: 'invalid' } }),
		() => studio.readFile({ projectId: project.id, path: '../outside' }),
		() => studio.renderPage({ ...target, revision: compiled.revision, page: 0 }),
		() =>
			studio.renderPage({
				...target,
				revision: compiled.revision,
				page: 1,
				region: { x: 0, y: 0, width: 10000, height: 10 },
			}),
		() => studio.renderPage({ ...target, revision: 'unavailable', page: 1 }),
	]) {
		await assert.rejects(
			async () => await operation(),
			(error) => {
				errors.push({
					code: error.code,
					message: error.message,
					diagnostics: error.diagnostics,
					issues: error.issues,
				})
				return typeof error.code === 'string'
			},
		)
	}
	if (config.phase === 1) {
		const description = await studio.describeDocument(target)
		assert.ok(description.fields.length > 0, 'Invalid data leaves fields independently readable')
		for (const [path, broken] of [
			[target.entry, '\nconst malformed = ;\n'],
			['报表/季度经营分析/排版.typ', '\n#unknown-native-function()\n'],
		]) {
			const source = await studio.readFile({ projectId: project.id, path })
			const changed = await studio.writeFile({
				projectId: project.id,
				path,
				content: source.content + broken,
				expectedVersion: source.version,
			})
			try {
				await assert.rejects(
					async () => await studio.compile({ clientRevision: 0, ...target, data: {} }),
					(error) => {
						const failure = JSON.stringify({
							path,
							code: error.code,
							message: error.message,
							diagnostics: error.diagnostics,
							issues: error.issues,
						})
						assert.equal(error.code, 'COMPILE_FAILED', failure)
						assert.ok(Array.isArray(error.diagnostics), `Missing compile diagnostics: ${failure}`)
						assert.ok(
							error.diagnostics.some((item) => item.path === path && item.range?.start.line >= 0),
							`Actual diagnostics retain workspace source locations: ${failure}`,
						)
						errors.push({
							code: error.code,
							message: error.message,
							diagnostics: error.diagnostics,
							issues: error.issues,
						})
						return true
					},
				)
			} finally {
				await studio.writeFile({
					projectId: project.id,
					path,
					content: source.content,
					expectedVersion: changed.version,
				})
			}
		}
	}
	// Another authenticated client changes the retained native document. No automatic replay.
	const other = await connectStudio(instance)
	let retained
	try {
		retained = await other.api.compile({ clientRevision: 0, ...target, data: { revenue: 1500000 } })
		await assert.rejects(
			async () => await studio.renderPage({ ...target, revision: compiled.revision, page: 1 }),
			{ code: 'REVISION_CONFLICT' },
		)
	} finally {
		other.disconnect()
	}
	result = {
		instanceId: instance.instanceId,
		projectId: project.id,
		target,
		compiled,
		retained,
		artifacts,
		crop,
		pdf,
		errors,
		disconnectedAfterCompile: true,
		importIsolation: true,
		imports,
	}
})
console.log(JSON.stringify(result))
