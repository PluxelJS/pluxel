import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getSchema } from '@tiptap/core'
import * as v from 'valibot'
import {
	collectTypstReferenceTargets,
	createTypstExtensions,
	exportTypstMarkdown,
	generateTypstRegions,
	prepareTypstCandidate,
	validateTypstDraft,
	validateTypstRegions,
	type TypstDocumentDraft,
	type TypstEditorIssue,
	type TypstEditorResult,
} from '@pluxel/plugin-typst/tiptap'
import { config, dataSchema, initialDraft, templateId, templateRevision } from './model.ts'

export class ReportError extends Error {
	constructor(readonly issues: readonly (TypstEditorIssue & { file?: string })[]) {
		super(
			issues
				.map(
					(issue) => `${issue.file ?? issue.regionId ?? 'report'}: ${issue.code}: ${issue.message}`,
				)
				.join('\n'),
		)
	}
}

export function accepted<T>(result: TypstEditorResult<T>): T {
	if (!result.ok)
		throw new ReportError(
			result.issues.map((issue) => ({
				...issue,
				...(issue.regionId ? { file: `content/${issue.regionId}.md` } : {}),
			})),
		)
	return result.value
}

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const manifestSchema = v.strictObject({
	formatVersion: v.literal(1),
	format: v.literal('agent'),
	templateId: v.literal(templateId),
	templateRevision: v.literal(templateRevision),
	baseRevision: v.string(),
	files: v.record(v.string(), v.string()),
	contextHashes: v.record(v.string(), v.string()),
})

async function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
	await mkdir(join(root, '.state'), { recursive: true })
	const path = join(root, '.state/write.lock')
	const lock = await open(path, 'wx')
	try {
		return await action()
	} finally {
		await lock.close()
		await rm(path)
	}
}

export async function initialize(root: string) {
	return locked(root, async () => {
		const draft = initialDraft()
		await writeFile(join(root, '.state/draft.json'), json(draft), { flag: 'wx' })
		return { initialized: true }
	})
}

export async function snapshot(root: string) {
	const draft = accepted(
		validateTypstDraft({
			draft: JSON.parse(await readFile(join(root, '.state/draft.json'), 'utf8')),
			config,
			templateId,
			templateRevision,
		}),
	)
	const data = v.parse(dataSchema, draft.data)
	const template = await readFile(join(root, 'template/main.typ'), 'utf8')
	const image = await readFile(join(root, 'template/revenue.svg'))
	const revision = digest(json([draft, template, digest(image)]))
	return { draft, data, template, image, revision }
}

export async function checkout(root: string, directory: string) {
	const current = await snapshot(root)
	// A checkout is new and independent: never overwrite an agent's existing edits.
	await mkdir(directory)
	const files: Record<string, string> = {}
	const hashes: Record<string, string> = {}
	const schema = getSchema(createTypstExtensions(config))
	let markdownBytes = 0
	for (const region of config.regions) {
		const exported = accepted(
			exportTypstMarkdown({
				document: current.draft.regions[region.id],
				regionId: region.id,
				config,
				data: current.data,
				format: 'agent',
			}),
		)
		if (!exported.lossless) throw new Error('An editable checkout must be lossless')
		const path = `content/${region.id}.md`
		files[path] = region.id
		await output(directory, path, exported.markdown)
		markdownBytes += Buffer.byteLength(exported.markdown)
		// Exercise native schema admission at the consumer boundary too.
		schema.nodeFromJSON(current.draft.regions[region.id]).check()
	}
	for (const [path, value] of Object.entries({
		'context/data.json': json(current.data),
		'context/references.json': json(collectTypstReferenceTargets(current.draft.regions, config)),
		'assets/revenue.svg': current.image,
		'AGENTS.md': await readFile(join(root, 'instructions.md'), 'utf8'),
	})) {
		await output(directory, path, value)
		hashes[path] = digest(value)
	}
	await output(
		directory,
		'manifest.json',
		json({
			formatVersion: 1,
			format: 'agent',
			templateId,
			templateRevision,
			baseRevision: current.revision,
			files,
			contextHashes: hashes,
		}),
	)
	return {
		directory,
		baseRevision: current.revision,
		markdownBytes,
		regions: config.regions.length,
	}
}

export async function prepare(root: string, directory: string) {
	const current = await snapshot(root)
	const manifest = v.parse(
		manifestSchema,
		JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')),
	)
	if (manifest.baseRevision !== current.revision)
		throw new ReportError([
			{
				code: 'STALE_CANDIDATE',
				message: '正文、数据或模板已变化。保留当前文件，重新 checkout 后显式迁移修改。',
			},
		])
	const expectedFiles = Object.fromEntries(config.regions.map(({ id }) => [`content/${id}.md`, id]))
	if (
		Object.keys(manifest.files).length !== Object.keys(expectedFiles).length ||
		Object.entries(expectedFiles).some(([path, id]) => manifest.files[path] !== id)
	)
		throw new ReportError([{ code: 'REGION_SET', message: '文件清单必须与模板声明的区域一致。' }])
	const entries = await readdir(join(directory, 'content'), { withFileTypes: true })
	if (
		entries.length !== config.regions.length ||
		entries.some(
			(entry) => !entry.isFile() || !Object.hasOwn(expectedFiles, `content/${entry.name}`),
		)
	)
		throw new ReportError([
			{
				code: 'REGION_SET',
				message: 'content/ 必须保留所有已声明文件，不能新增、删除或重命名区域。',
			},
		])
	const expectedContext = [
		'context/data.json',
		'context/references.json',
		'assets/revenue.svg',
		'AGENTS.md',
	]
	if (
		Object.keys(manifest.contextHashes).length !== expectedContext.length ||
		expectedContext.some((path) => !Object.hasOwn(manifest.contextHashes, path))
	)
		throw new Error('Checkout context manifest is incomplete')
	for (const path of expectedContext) {
		if (digest(await readFile(join(directory, path))) !== manifest.contextHashes[path])
			throw new ReportError([
				{
					code: 'INVALID_RESOURCE',
					file: path,
					message: '本实验的上下文是只读快照；请只修改 content/*.md。',
				},
			])
	}
	const regions = { ...current.draft.regions }
	const changed: string[] = []
	const schema = getSchema(createTypstExtensions(config))
	for (const [path, regionId] of Object.entries(expectedFiles)) {
		const prepared = accepted(
			prepareTypstCandidate({
				candidate: {
					regionId,
					baseRevision: manifest.baseRevision,
					format: 'agent',
					markdown: await readFile(join(directory, path), 'utf8'),
				},
				currentRevision: current.revision,
				document: regions[regionId]!,
				config,
				data: current.data,
				canEdit: (id) => config.regions.some((region) => region.id === id),
			}),
		)
		if (!schema.nodeFromJSON(regions[regionId]!).eq(schema.nodeFromJSON(prepared.mergedDocument)))
			changed.push(regionId)
		regions[regionId] = prepared.mergedDocument
	}
	accepted(validateTypstRegions({ regions, config, data: current.data }))
	const draft: TypstDocumentDraft = { ...current.draft, regions }
	// Includes cross-region reference and resource checks, without claiming compilation succeeded.
	const generated = accepted(
		generateTypstRegions({
			regions,
			config,
			data: current.data,
			snapshotRevision: current.revision,
		}),
	)
	return { ...current, draft, generated, changed }
}

export async function apply(root: string, directory: string) {
	return locked(root, async () => {
		const candidate = await prepare(root, directory)
		if (candidate.changed.length === 0)
			return { saved: false, changed: [], revision: candidate.revision }
		const temporary = join(root, `.state/draft-${randomUUID()}.json`)
		try {
			await writeFile(temporary, json(candidate.draft), { flag: 'wx' })
			await rename(temporary, join(root, '.state/draft.json'))
		} finally {
			await rm(temporary, { force: true })
		}
		const saved = await snapshot(root)
		return { saved: true, changed: candidate.changed, revision: saved.revision }
	})
}

export async function output(root: string, path: string, value: string | Uint8Array) {
	const destination = join(root, path)
	await mkdir(dirname(destination), { recursive: true })
	await writeFile(destination, value)
}

export async function renderJob(root: string, directory: string) {
	const candidate = await prepare(root, directory)
	const job = resolve(root, '.artifacts', `render-${randomUUID()}`)
	await output(job, 'template/main.typ', candidate.template)
	for (const [path, source] of Object.entries(candidate.generated.templateFiles))
		await output(job, `template/${path}`, source)
	await output(job, 'revenue.svg', candidate.image)
	const files = Object.fromEntries(
		Object.entries(candidate.generated.inputFiles).map(([path, text]) => [
			path,
			{ kind: 'text', text },
		]),
	)
	await output(
		job,
		'inputs.json',
		json({
			...files,
			'/inputs/assets/revenue.svg': { kind: 'file', path: join(job, 'revenue.svg') },
		}),
	)
	await output(job, 'candidate.json', json(candidate.draft))
	return job
}

export async function render(root: string, directory: string, fonts: string[]) {
	if (fonts.length === 0) throw new Error('Provide font paths, including Noto Serif CJK SC.')
	const job = await renderJob(root, directory)
	const { createHost } = await import('@pluxel/host')
	const { pluginNodeAddressOf } = await import('@pluxel/core')
	const { FontsPlugin } = await import('@pluxel/plugin-fonts')
	const { TypstPlugin } = await import('@pluxel/plugin-typst')
	const { nodeModules } = await import('@pluxel/services/node')
	const { ReportRenderPlugin } = await import('./index.ts')
	const host = await createHost({
		plugins: [FontsPlugin, TypstPlugin, ReportRenderPlugin],
		services: [
			nodeModules({
				root: resolve(
					dirname(fileURLToPath(import.meta.resolve('@pluxel/plugin-typst/package.json'))),
					'dist/artifacts/node',
				),
			}),
		],
		configRecords: {
			initial: [
				{
					owner: pluginNodeAddressOf(FontsPlugin),
					config: { files: fonts, maxFontBytes: 64 * 1024 * 1024 },
				},
				{ owner: pluginNodeAddressOf(ReportRenderPlugin), config: { job } },
			],
		},
		state: { initial: { autoStart: [pluginNodeAddressOf(ReportRenderPlugin)] } },
	})
	try {
		const report = await host.start()
		if (
			report.reconciliation.length > 0 ||
			(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
		)
			throw new Error('Report consumer failed', { cause: report })
		return { job, ...JSON.parse(await readFile(join(job, 'compile.json'), 'utf8')) }
	} finally {
		await host.close()
	}
}
