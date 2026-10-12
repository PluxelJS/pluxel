import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const applicationRoot = resolve(process.env.STUDIO_APP_ROOT ?? projectRoot)
const root = await mkdtemp(join(tmpdir(), 'pluxel-studio-runtime-'))
const originalListen = Server.prototype.listen
let listenAttempts = 0
let backend
let renderHost
let pageImages = 0
// Include production entry import, Vite initialization and requests in the no-listen check.
Server.prototype.listen = function () {
	listenAttempts += 1
	throw new Error('Studio must not open a network listener')
}
async function fetchJson(path, method = 'GET', input) {
	const response = await backend.fetch(
		new Request(`http://studio.local${path}`, {
			method,
			...(input === undefined
				? {}
				: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
		}),
	)
	const body = await response.json()
	assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(body)}`)
	return body
}
async function pdf(path, result) {
	const response = await backend.fetch(
		new Request(
			`http://studio.local${path}/pdf?entry=${encodeURIComponent(result.entry)}&revision=${result.revision}`,
		),
	)
	assert.equal(response.status, 200)
	assert.equal(response.headers.get('content-type'), 'application/pdf')
	const bytes = Buffer.from(await response.arrayBuffer())
	assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
	assert.ok(bytes.length > 100)
	return bytes
}
try {
	const { startBackend } = await import(
		pathToFileURL(join(applicationRoot, 'dist/runtime.mjs')).href
	)
	backend = await startBackend({
		root,
		assetsRoot: join(applicationRoot, 'financial-document-assets'),
	})
	const project = await fetchJson('/api/projects', 'POST', { name: 'Production workspace' })
	const projects = await fetchJson('/api/projects')
	assert.ok(projects.some((item) => item.id === project.id))
	const path = `/api/projects/${encodeURIComponent(project.id)}`
	const tree = await fetchJson(`${path}/tree`)
	assert.equal(tree.documents.length, 3)
	assert.ok(!tree.entries.some((entry) => entry.path.endsWith('/data.json')))
	const providers = await fetchJson('/api/ai/providers')
	assert.ok(providers.providers.length > 10)
	const company = providers.providers.find((provider) => provider.id === 'company-proxy')
	assert.equal(company.api, 'openai-responses')
	assert.equal(company.model, 'deepseek-flash')
	assert.equal(company.imageInput, true, 'Bundled models.dev enables images through the proxy')
	const compiled = []
	for (const document of tree.documents) {
		const result = await fetchJson(`${path}/compile`, 'POST', { entry: document.entry })
		assert.equal(result.projectId, project.id)
		assert.equal(result.entry, document.entry)
		assert.match(result.revision, /^[a-f0-9]{64}$/)
		assert.equal(result.preview.format, 'vector')
		assert.ok(result.preview.data.length > 0)
		assert.ok(result.preview.navigation.pages.length > 0, 'Native preview exposes page sizes')
		assert.ok(
			result.preview.navigation.points.length > 0,
			'Preview carries native source positions',
		)
		for (const point of result.preview.navigation.points) {
			assert.ok(
				Object.hasOwn(result.sourceVersions, point.path),
				'Navigation refers to saved sources',
			)
			assert.equal(
				result.sourceVersions[point.path],
				tree.entries.find((entry) => entry.path === point.path)?.version,
				'Navigation source version matches the actual compiled file',
			)
		}
		if (document.name === '季度经营分析') {
			const overview = result.preview.navigation.outline.find((item) => item.title === '经营概况')
			const projectHeading = result.preview.navigation.outline.find(
				(item) => item.title === '项目执行明细',
			)
			assert.ok(overview && projectHeading, 'Native outline exposes actual Chinese headings')
			assert.ok(Number.isInteger(overview.page) && overview.page >= 1)
			assert.ok(Number.isInteger(projectHeading.page) && projectHeading.page > overview.page)
			for (const heading of result.preview.navigation.outline) {
				assert.ok(heading.title.length > 0)
				assert.ok(Number.isInteger(heading.page) && heading.page >= 1)
				assert.ok(Number.isFinite(heading.x) && Number.isFinite(heading.y))
			}
		}
		assert.ok(result.fields.length > 0, 'Schema evaluation exposes fields')
		assert.ok(
			Object.keys(result.data).length > 0,
			'Valibot defaults populate external input without data.json',
		)
		assert.ok(!result.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))
		compiled.push({ result, pdf: await pdf(path, result) })
	}
	const initial = compiled.find((item) => item.result.name === '银行询证函')?.result
	assert.ok(initial, 'Starter includes the bank confirmation document')
	const inputUpdate = await fetchJson(`${path}/compile`, 'POST', {
		entry: initial.entry,
		data: { header: { bankName: 'External business input' } },
	})
	assert.equal(
		inputUpdate.preview.sessionId,
		initial.preview.sessionId,
		'Production native session is retained',
	)
	assert.ok(inputUpdate.preview.revision > initial.preview.revision)
	assert.notEqual(inputUpdate.revision, initial.revision)
	assert.equal(inputUpdate.data.header.bankName, 'External business input')
	const storedInput = await fetchJson(`${path}/input?entry=${encodeURIComponent(initial.entry)}`)
	assert.deepEqual(storedInput.data, {}, 'One-shot input is not persisted')
	const theme = join(project.root, '共享/主题/财务函件.typ')
	const original = await readFile(theme, 'utf8')
	assert.ok(original.includes('  body\n}'))
	// External editor writes the real shared file: no Studio write endpoint is involved.
	await writeFile(theme, original.replace('  body\n}', '  text("Runtime HMR update")\n  body\n}'))
	for (const previous of compiled) {
		const changed = await fetchJson(`${path}/compile`, 'POST', { entry: previous.result.entry })
		assert.notEqual(
			changed.revision,
			previous.result.revision,
			'External shared theme edit changes workspace revision',
		)
		assert.notDeepEqual(
			changed.preview.data,
			previous.result.preview.data,
			'Each document preview reflects the shared theme edit',
		)
		assert.notDeepEqual(await pdf(path, changed), previous.pdf)
		const stale = await backend.fetch(
			new Request(
				`http://studio.local${path}/pdf?entry=${encodeURIComponent(changed.entry)}&revision=${previous.result.revision}`,
			),
		)
		assert.equal(stale.status, 409, 'PDF rejects the superseded document revision')
	}
	const exported = await backend.fetch(new Request(`http://studio.local${path}/export`))
	assert.equal(exported.status, 200)
	assert.equal(exported.headers.get('content-type'), 'application/zip')
	const archive = Buffer.from(await exported.arrayBuffer())
	assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304')
	// Resolve every module from the application being shipped, including its
	// native worker artifact. This phase also runs on Windows without system fonts.
	const applicationRequire = createRequire(join(applicationRoot, 'package.json'))
	const load = (name) => import(pathToFileURL(applicationRequire.resolve(name)).href)
	const { createHost } = await load('@pluxel/host')
	// Core ships both module formats; its ESM declaration registry must match
	// the ESM Host and plugins rather than require.resolve's CommonJS registry.
	const coreManifest = applicationRequire.resolve('@pluxel/core/package.json')
	const corePackage = JSON.parse(await readFile(coreManifest, 'utf8'))
	const { pluginNodeAddressOf } = await import(
		new URL(corePackage.exports['.'].import, pathToFileURL(coreManifest)).href
	)
	const { requirePluginService } = await import(
		new URL(corePackage.exports['./internal'].import, pathToFileURL(coreManifest)).href
	)
	const { FontsPlugin } = await load('@pluxel/fonts')
	const { TypstPlugin } = await load('@pluxel/typst')
	const { nodeModules } = await load('@pluxel/services/node')
	const probeRoot = join(root, 'native-page-probe')
	await mkdir(probeRoot)
	await writeFile(
		join(probeRoot, 'main.typ'),
		'#set page(width: 240pt, height: 300pt, margin: 20pt)\n' +
			'= Opening\n$ integral_0^1 x^2 dif x = 1/3 $\n' +
			'#pagebreak()\n= Continuation\nLast page.',
	)
	renderHost = await createHost({
		plugins: [FontsPlugin, TypstPlugin],
		services: [
			nodeModules({
				root: join(
					dirname(applicationRequire.resolve('@pluxel/typst/package.json')),
					'dist/artifacts/node',
				),
			}),
		],
		state: { initial: { autoStart: [pluginNodeAddressOf(TypstPlugin)] } },
	})
	const report = await renderHost.start()
	assert.equal(report.reconciliation.length, 0, 'Packaged render host reconciles cleanly')
	assert.equal(report.core.status, 'committed')
	assert.equal(report.core.summary.lifecycleReport.ok, true)
	const typst = requirePluginService(renderHost.ctx).getInstance(pluginNodeAddressOf(TypstPlugin))
	assert.ok(typst, 'Packaged Typst plugin is running')
	await using session = await typst.open({
		root: probeRoot,
		entry: 'main.typ',
	})
	const document = await session.update({ files: {} })
	assert.equal(document.preview.navigation.pages.length, 2)
	for (const page of [1, 2]) {
		const image = await session.renderPage({ revision: document.revision, page, scale: 2 })
		const bytes = Buffer.from(image.data)
		assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
		assert.equal(bytes.readUInt32BE(16), image.width)
		assert.equal(bytes.readUInt32BE(20), image.height)
		assert.equal(image.width, 480)
		assert.equal(image.height, 600)
		pageImages += 1
	}
	const cropped = await session.renderPage({
		revision: document.revision,
		page: 1,
		scale: 2,
		region: { x: 20, y: 20, width: 100, height: 80 },
	})
	assert.equal(cropped.width, 200)
	assert.equal(cropped.height, 160)
	assert.deepEqual(cropped.region, { x: 20, y: 20, width: 100, height: 80 })
	pageImages += 1
	await session.update({ files: {} })
	await assert.rejects(session.renderPage({ revision: document.revision, page: 1 }), {
		code: 'STALE_REVISION',
	})
	assert.equal(listenAttempts, 0)
	console.log(
		JSON.stringify({
			projects: projects.length,
			documents: compiled.length,
			navigationPoints: compiled.reduce(
				(count, item) => count + item.result.preview.navigation.points.length,
				0,
			),
			sharedThemeUpdated: true,
			zipBytes: archive.length,
			pageImages,
			proxyImageInput: company.imageInput,
			listenAttempts,
		}),
	)
} finally {
	try {
		await Promise.all([renderHost?.close(), backend?.close()])
	} finally {
		Server.prototype.listen = originalListen
		await rm(root, { recursive: true, force: true })
	}
}
