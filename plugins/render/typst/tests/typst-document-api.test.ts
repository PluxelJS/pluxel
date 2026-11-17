import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { JSONContent } from '@tiptap/core'
import { createTypstDocumentProject } from '@pluxel/plugin-typst/document'
import { createTypstSourceProject } from '@pluxel/plugin-typst/source'
import { typstSourceLibrary } from '@pluxel/plugin-typst/source/library'
import { describe, expect, it, vi } from 'vitest'
import { loadNativeCompiler, type NavigationDocument } from '../src/native-binding.ts'

// A server can use both public entries without loading an editor or React runtime.
vi.mock('@tiptap/core', () => {
	throw new Error('Server document API loaded Tiptap')
})
vi.mock('react', () => {
	throw new Error('Server document API loaded React')
})

const all = (node: JSONContent): JSONContent[] => [node, ...(node.content?.flatMap(all) ?? [])]
const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
const image =
	'<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="red"/></svg>'

function single(resource = '../assets/diagram.svg') {
	const files = {
		'internal/report.typ': `#import "../lib/private.typ": policy
#import "../lib/pluxel.typ" as report
#set text(size: 11pt)
#let secret = "PRIVATE_SOURCE_CANARY"
= Overview <private:overview>

Ordinary prose with *emphasis* and #link("${resource}")[Download].

== Details <private:details>
#figure(image("${resource}"), caption: [Diagram]) <private:diagram>

#figure(table(columns: 2, [Name], [Value], [Ada], [42]), caption: [Results]) <private:results>

#report.latex("x^2 + y^2 = z^2", block: true) <private:equation>

#upper("PRIVATE_PROTECTED_CANARY")

See @private:diagram.`,
		'lib/private.typ': '#let policy = true',
		'lib/pluxel.typ': typstSourceLibrary,
		'assets/diagram.svg': image,
	}
	const project = createTypstSourceProject({ files, writablePaths: ['internal/report.typ'] })
	const documents = createTypstDocumentProject({
		project,
		documents: [{ id: 'report', title: 'Report', path: 'internal/report.typ' }],
		resources: [{ path: 'assets/diagram.svg', url: '/assets/public-diagram' }],
	})
	return { files, project, documents }
}

describe('public source-free document project', () => {
	it.each(['', '#set text(size: 11pt)\n'])(
		'opens an empty body with a caret without authoring an empty block: %j',
		(source) => {
			const project = createTypstSourceProject({ files: { 'body.typ': source } })
			const documents = createTypstDocumentProject({
				project,
				documents: [{ id: 'body', title: 'Body', path: 'body.typ' }],
			})
			const document = documents.view().documents[0]!.document
			expect(document.content).toEqual([{ type: 'paragraph' }])
			expect(documents.edit({ baseRevision: 0, id: 'body', document })).toMatchObject({ ok: true })
			expect(project.snapshot()).toEqual({ revision: 0, files: { 'body.typ': source } })
			document.content![0]!.content = [{ type: 'text', text: 'First line.' }]
			expect(documents.edit({ baseRevision: 0, id: 'body', document })).toMatchObject({ ok: true })
			expect(project.snapshot().files['body.typ']).toContain('First line.')
			project.undo()
			expect(project.snapshot().files['body.typ']).toBe(source)
		},
	)
	it('projects an ordinary rich document, keeps environment imports private and preserves no-op bytes/history', () => {
		const { files, project, documents } = single()
		const view = documents.view()
		const wire = JSON.stringify(view)
		for (const privateValue of [
			'.typ',
			'private:',
			'PRIVATE_',
			'#import',
			'"label":',
			'diagram.svg',
		])
			expect(wire).not.toContain(privateValue)
		const nodes = all(view.documents[0]!.document)
		for (const type of ['heading', 'table', 'blockMath', 'image', 'reference', 'documentBlock'])
			expect(nodes.some((node) => node.type === type)).toBe(true)
		expect(nodes.find((node) => node.type === 'image')!.attrs!.src).toBe('/assets/public-diagram')
		expect(view.references.map((reference) => reference.kind)).toEqual(
			expect.arrayContaining(['heading', 'figure', 'table', 'equation']),
		)
		expect(new Set(view.references.map((reference) => reference.id)).size).toBe(
			view.references.length,
		)
		for (const reference of view.references) expect(reference.id.length).toBeGreaterThan(0)
		expect(
			documents.edit({
				baseRevision: view.revision,
				id: 'report',
				document: view.documents[0]!.document,
			}),
		).toMatchObject({ ok: true })
		expect(project.snapshot()).toEqual({ revision: 0, files })
		expect(project.canUndo).toBe(false)
	})

	it.each(['../assets/diagram.svg', '/assets/diagram.svg'])(
		'normalizes registered resource %s without rewriting an echoed document',
		(resource) => {
			const { files, project, documents } = single(resource)
			const view = documents.view()
			expect(
				documents.edit({
					baseRevision: view.revision,
					id: 'report',
					document: view.documents[0]!.document,
				}),
			).toMatchObject({ ok: true })
			expect(project.snapshot()).toEqual({ revision: 0, files })
		},
	)

	it('keeps inserted and duplicated object/reference identities through subsequent edits, echoes and source history', () => {
		const { files, project, documents } = single()
		const before = documents.view()
		const document = structuredClone(before.documents[0]!.document)
		const originalFigure = all(document).find((node) => node.type === 'figure')!
		const originalId = originalFigure.attrs!.id
		const duplicate = structuredClone(originalFigure)
		duplicate.attrs!.id = randomUUID()
		all(duplicate).find((node) => node.text === 'Diagram')!.text = 'Copy of diagram'
		const headingId = randomUUID()
		document.content!.push(
			{
				type: 'paragraph',
				content: [{ type: 'reference', attrs: { target: duplicate.attrs!.id } }],
			},
			duplicate,
			{
				type: 'heading',
				attrs: { id: headingId, level: 2 },
				content: [{ type: 'text', text: 'New section' }],
			},
		)
		const accepted = documents.edit({ baseRevision: before.revision, id: 'report', document })
		expect(accepted).toMatchObject({ ok: true })
		if (!accepted.ok) return
		const ids = [originalId, duplicate.attrs!.id, headingId]
		for (const id of ids)
			expect(accepted.value.references.some((reference) => reference.id === id)).toBe(true)
		const firstFiles = project.snapshot().files
		expect(
			documents.edit({
				baseRevision: accepted.value.revision,
				id: 'report',
				document: accepted.value.documents[0]!.document,
			}),
		).toMatchObject({ ok: true })
		expect(project.snapshot().files).toEqual(firstFiles)
		expect(project.revision).toBe(1)
		const edited = documents.view().documents[0]!.document
		edited.content!.push(paragraph('Second accepted edit.'))
		expect(
			documents.edit({ baseRevision: project.revision, id: 'report', document: edited }),
		).toMatchObject({ ok: true })
		for (const id of ids)
			expect(documents.view().references.some((reference) => reference.id === id)).toBe(true)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files).toEqual(firstFiles)
		expect(project.undo().ok).toBe(true)
		expect(project.snapshot().files).toEqual(files)
		expect(documents.view().references.find((reference) => reference.title === 'Diagram')!.id).toBe(
			originalId,
		)
		expect(project.redo().ok).toBe(true)
		for (const id of ids)
			expect(documents.view().references.some((reference) => reference.id === id)).toBe(true)
		expect(
			all(documents.view().documents[0]!.document)
				.filter((node) => node.type === 'reference')
				.map((node) => node.attrs!.target),
		).toContain(duplicate.attrs!.id)
	})

	it('rejects source injection, forged references, malformed fields and protected mutation atomically', () => {
		const changes: ((document: JSONContent) => void)[] = [
			(document) =>
				document.content!.push({
					type: 'typstSource',
					attrs: { source: '#include "private.typ"' },
				}),
			(document) => {
				document.content![0]!.attrs!.path = 'internal/report.typ'
			},
			(document) => {
				document.content = document.content!.filter((node) => node.type !== 'documentBlock')
			},
			(document) => {
				all(document).find((node) => node.type === 'documentBlock')!.attrs!.title =
					'Changed fixed content'
			},
			(document) => {
				all(document).find((node) => node.type === 'reference')!.attrs!.target = 'private:diagram'
			},
			(document) => {
				all(document).find((node) => node.type === 'image')!.attrs!.src = '/assets/not-registered'
			},
			(document) => {
				all(document).find((node) => node.type === 'heading')!.attrs!.level = 'malformed'
			},
			(document) => {
				document.content!.push({ type: 'image' })
			},
			(document) => {
				document.content!.push({ type: 'figure' })
			},
		]
		for (const change of changes) {
			const { files, project, documents } = single()
			const document = documents.view().documents[0]!.document
			change(document)
			const result = documents.edit({ baseRevision: 0, id: 'report', document })
			expect(result).toMatchObject({ ok: false, issues: [{ code: 'INVALID_EDIT' }] })
			for (const privateValue of ['.typ', 'private:', 'PRIVATE_', '#include'])
				expect(JSON.stringify(result)).not.toContain(privateValue)
			expect(project.snapshot()).toEqual({ revision: 0, files })
			expect(project.canUndo).toBe(false)
		}
	})

	it('respects borrowed write permissions and rejects stale revisions with safe results', () => {
		const { project, documents } = single()
		const baseline = project.snapshot()
		const original = documents.view().documents[0]!.document
		expect(documents.edit({ baseRevision: 99, id: 'report', document: original })).toMatchObject({
			ok: false,
			issues: [{ code: 'CONFLICT' }],
		})
		const readonly = createTypstDocumentProject({
			project,
			documents: [{ id: 'fixed', title: 'Policy', path: 'lib/private.typ' }],
		})
		expect(readonly.view().documents[0]!.editable).toBe(false)
		expect(
			readonly.edit({
				baseRevision: 0,
				id: 'fixed',
				document: { type: 'doc', content: [paragraph('Overwrite')] },
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'READ_ONLY' }] })
		expect(project.snapshot()).toEqual(baseline)
	})
})

it('maps generated template labels and native links to safe identities, including a fixed target without an editor destination', async () => {
	const files = {
		'private/main.typ': `#set page(width: 300pt, height: 220pt, margin: 20pt)
#set text(font: "DejaVu Sans", lang: "en")
#set heading(numbering: "1.")
#for (name, path) in (("first", "first.typ"), ("second", "second.typ")) {
  [#heading("Shared title")#label("hidden-chapter-" + name)]
  include path
  pagebreak()
}
= Fixed annex <hidden-fixed>
#link("custom:private")[Private]`,
		'private/first.typ':
			'= Shared title <hidden-body>\n\nSee @hidden-chapter-second and @hidden-fixed.\n\n#link("https://example.com/public")[Public]\n\n#link("../assets/guide.pdf")[Guide]',
		'private/second.typ': 'Second editable body.',
		'assets/guide.pdf': 'Registered download fixture',
	}
	const project = createTypstSourceProject({
		files,
		writablePaths: ['private/first.typ', 'private/second.typ'],
	})
	const documents = createTypstDocumentProject({
		project,
		documents: [
			{ id: 'first', title: 'First', path: 'private/first.typ', label: 'hidden-chapter-first' },
			{ id: 'second', title: 'Second', path: 'private/second.typ', label: 'hidden-chapter-second' },
		],
		references: [{ label: 'hidden-fixed', title: 'Fixed annex', kind: 'heading' }],
		resources: [{ path: 'assets/guide.pdf', url: '/document-resources/guide' }],
	})
	const root = await mkdtemp(join(tmpdir(), 'typst-public-document-api-'))
	try {
		for (const [path, content] of Object.entries(files)) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), content)
		}
		const compiler = loadNativeCompiler(
			fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
		).create({
			workspace: root,
			fontArgs: [
				{
					fontPaths: [
						execFileSync('fc-match', ['-f', '%{file}', 'DejaVu Sans'], { encoding: 'utf8' }),
					],
				},
			],
		})
		const compiled = compiler.compile({ mainFilePath: join(root, 'private/main.typ') })
		expect(compiled.result).toBeDefined()
		const native = (compiled.result! as NavigationDocument).navigation()
		const mapped = documents.navigation({ revision: project.revision, navigation: native })
		expect(mapped.ok).toBe(true)
		if (!mapped.ok) return
		const view = documents.view()
		for (const [label, title] of [
			['hidden-chapter-first', 'First'],
			['hidden-chapter-second', 'Second'],
			['hidden-fixed', 'Fixed annex'],
		] as const) {
			const actual = native.targets.find((target) => target.label === label)!
			const reference = view.references.find((target) => target.title === title)!
			const target = mapped.value.targets.find((item) => item.id === reference.id)!
			expect(target).toMatchObject({
				id: reference.id,
				page: actual.page,
				x: actual.x,
				y: actual.y,
			})
			expect(target.location).toEqual(
				title === 'Fixed annex' ? undefined : { documentId: title.toLowerCase(), position: 0 },
			)
		}
		const fixed = mapped.value.targets.find((target) => !target.location)!
		expect(mapped.value.links).toContainEqual(
			expect.objectContaining({
				title: 'Fixed annex',
				target: { kind: 'position', page: fixed.page, x: fixed.x, y: fixed.y },
			}),
		)
		expect(mapped.value.links).toContainEqual(
			expect.objectContaining({ target: { kind: 'url', url: 'https://example.com/public' } }),
		)
		expect(mapped.value.links).toContainEqual(
			expect.objectContaining({ target: { kind: 'url', url: '/document-resources/guide' } }),
		)
		expect(
			mapped.value.links.some(
				(link) => link.target.kind === 'url' && link.target.url.startsWith('custom:'),
			),
		).toBe(false)
		expect(
			mapped.value.points.some((point) => point.documentId === 'first' && point.position === 1),
		).toBe(true)
		for (const value of ['hidden-', 'private/', '.typ', '"path":', '"label":', '"line":'])
			expect(JSON.stringify({ view, navigation: mapped.value })).not.toContain(value)
		const compiledRevision = project.revision
		view.documents[1]!.document.content!.push(paragraph('Changed after compilation.'))
		expect(
			documents.edit({
				baseRevision: compiledRevision,
				id: 'second',
				document: view.documents[1]!.document,
			}),
		).toMatchObject({ ok: true })
		expect(documents.navigation({ revision: compiledRevision, navigation: native })).toMatchObject({
			ok: false,
			issues: [{ code: 'CONFLICT' }],
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)
