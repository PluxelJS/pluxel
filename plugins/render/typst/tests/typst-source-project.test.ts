import { parse, parseAst } from '@r4ai/typst-ast-node'
import { describe, expect, it, vi } from 'vitest'
import {
	createTypstSourceProjectState,
	TypstSourceProjectError,
} from '../src/source/project-state.js'
import type { TypstSourceParser } from '../src/source/types.js'
import { typstSourceLibrary } from '../src/source/library.js'

const parser: TypstSourceParser = { parse, parseAst }
const bytes = (text: string) => new TextEncoder().encode(text).length

describe('source project transactions', () => {
	it('preserves every original byte on open and no-op save, including BOM, CRLF and unknown syntax', () => {
		const source = '\uFEFF// 保留\r\n中文 e\u0301 😀 #unknown(1) 后文\r\n'
		const project = createTypstSourceProjectState({ files: { 'main.typ': source } }, parser)
		const projection = project.open('main.typ')
		const result = project.edit({ projection, document: projection.document })
		expect(result.ok).toBe(true)
		expect(project.revision).toBe(0)
		expect(project.snapshot().files['main.typ']).toBe(source)
		expect(project.canUndo).toBe(false)
	})

	it('validates all files, overlap and UTF-8 boundaries before accepting any patch', () => {
		const project = createTypstSourceProjectState(
			{ files: { 'a.typ': '甲😀乙', 'b.typ': 'other' } },
			parser,
		)
		const change = vi.fn()
		project.subscribe(change)
		const invalid = project.apply({
			baseRevision: 0,
			patches: [
				{ path: 'b.typ', from: 0, to: 5, text: 'changed' },
				{ path: 'a.typ', from: 4, to: 7, text: 'x' },
			],
		})
		expect(invalid).toMatchObject({ ok: false, issues: [{ code: 'INVALID_PATCH', path: 'a.typ' }] })
		expect(project.snapshot()).toMatchObject({
			revision: 0,
			files: { 'a.typ': '甲😀乙', 'b.typ': 'other' },
		})
		expect(change).not.toHaveBeenCalled()
		expect(
			project.apply({
				baseRevision: 0,
				patches: [
					{ path: 'b.typ', from: 0, to: 3, text: 'x' },
					{ path: 'b.typ', from: 2, to: 5, text: 'y' },
				],
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'INVALID_PATCH' }] })
		expect(
			project.apply({ baseRevision: 0, patches: [{ path: 'a.typ', from: 3, to: 7, text: '🧪' }] })
				.ok,
		).toBe(true)
		expect(project.snapshot().files['a.typ']).toBe('甲🧪乙')
		expect(change).toHaveBeenCalledTimes(1)
	})

	it('does not partially write when a later file is read-only', () => {
		const project = createTypstSourceProjectState(
			{ files: { 'a.typ': 'A', 'b.typ': 'B' }, writablePaths: ['a.typ'] },
			parser,
		)
		expect(
			project.apply({
				baseRevision: 0,
				patches: [
					{ path: 'a.typ', from: 0, to: 1, text: 'new' },
					{ path: 'b.typ', from: 0, to: 1, text: 'new' },
				],
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'READ_ONLY', path: 'b.typ' }] })
		expect(project.snapshot().files).toEqual({ 'a.typ': 'A', 'b.typ': 'B' })
		expect(project.canUndo).toBe(false)
	})

	it('undoes and redoes all changed source and JSON files as one revision', () => {
		const files = { 'a.typ': '甲', 'data/sales.json': '{"sales":1}' }
		const project = createTypstSourceProjectState({ files }, parser)
		project.apply({
			baseRevision: 0,
			patches: [
				{ path: 'a.typ', from: 0, to: bytes('甲'), text: '乙' },
				{ path: 'data/sales.json', from: 9, to: 10, text: '2' },
			],
		})
		expect(project.snapshot().files).toEqual({ 'a.typ': '乙', 'data/sales.json': '{"sales":2}' })
		expect(project.undo()).toMatchObject({ ok: true, value: { revision: 2, files } })
		expect(project.redo()).toMatchObject({ ok: true, value: { revision: 3 } })
		expect(project.snapshot().files['data/sales.json']).toBe('{"sales":2}')
		expect(project.redo()).toMatchObject({ ok: false, issues: [{ code: 'NO_HISTORY' }] })
	})

	it('rejects stale prepared edits after Agent replacement and resets history', () => {
		const project = createTypstSourceProjectState({ files: { 'main.typ': 'Human' } }, parser)
		const original = project.open('main.typ')
		project.apply({
			baseRevision: 0,
			patches: [{ path: 'main.typ', from: 0, to: 5, text: 'First' }],
		})
		expect(
			project.replace({ baseRevision: 1, files: { 'main.typ': 'Agent', 'extra.typ': 'New' } }).ok,
		).toBe(true)
		expect(project.edit({ projection: original, document: original.document })).toMatchObject({
			ok: false,
			issues: [{ code: 'CONFLICT' }],
		})
		expect(
			project.apply({
				baseRevision: 1,
				patches: [{ path: 'main.typ', from: 0, to: 5, text: 'Stale' }],
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'CONFLICT' }] })
		expect(project.snapshot().files['main.typ']).toBe('Agent')
		expect(project.canUndo).toBe(false)
		expect(project.canRedo).toBe(false)
	})

	it('retains invalid source drafts and recovers projection after a source repair', () => {
		const project = createTypstSourceProjectState({ files: { 'main.typ': 'Valid' } }, parser)
		const invalid = '#text[unfinished'
		expect(
			project.apply({
				baseRevision: 0,
				patches: [{ path: 'main.typ', from: 0, to: 5, text: invalid }],
			}).ok,
		).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(invalid)
		expect(project.open('main.typ').editable).toBe(false)
		expect(project.diagnostics()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'SYNTAX_ERROR', path: 'main.typ', revision: 1 }),
			]),
		)
		expect(
			project.apply({
				baseRevision: 1,
				patches: [{ path: 'main.typ', from: bytes(invalid), to: bytes(invalid), text: ']' }],
			}).ok,
		).toBe(true)
		expect(project.open('main.typ').editable).toBe(true)
	})

	it('renames actual declarations/references atomically and leaves strings/comments untouched', () => {
		const first = '= Analysis <sec:old>\n// @sec:old <sec:old>\n#let note = "@sec:old"\n'
		const second = 'See @sec:old and @sec:old[Section].\n'
		const project = createTypstSourceProjectState(
			{ files: { 'a.typ': first, 'b.typ': second } },
			parser,
		)
		expect(project.renameLabel({ baseRevision: 0, from: 'sec:old', to: 'sec:new' }).ok).toBe(true)
		expect(project.snapshot().files).toEqual({
			'a.typ': first.replace('<sec:old>', '<sec:new>'),
			'b.typ': 'See @sec:new and @sec:new[Section].\n',
		})
		expect(project.undo()).toMatchObject({
			ok: true,
			value: { files: { 'a.typ': first, 'b.typ': second } },
		})
	})

	it('reports missing static references as uncertain and duplicate declarations as errors', () => {
		const project = createTypstSourceProjectState(
			{
				files: {
					'a.typ': '= A <sec:same>\nSee @generated and @citation.',
					'b.typ': '= B <sec:same>\n',
				},
			},
			parser,
		)
		const diagnostics = project.diagnostics()
		expect(diagnostics.filter((entry) => entry.code === 'DUPLICATE_LABEL')).toHaveLength(2)
		expect(diagnostics.filter((entry) => entry.code === 'UNRESOLVED_REFERENCE')).toEqual([
			expect.objectContaining({ severity: 'warning', path: 'a.typ' }),
			expect.objectContaining({ severity: 'warning', path: 'a.typ' }),
		])
		expect(project.renameLabel({ baseRevision: 0, from: 'sec:same', to: 'sec:new' })).toMatchObject(
			{ ok: false, issues: [{ code: 'DUPLICATE_LABEL' }] },
		)
		expect(project.revision).toBe(0)
	})

	it('rejects rename when any confirmed reference cannot be written', () => {
		const files = { 'a.typ': '= A <sec:a>', 'b.typ': '@sec:a' }
		const project = createTypstSourceProjectState({ files, writablePaths: ['a.typ'] }, parser)
		expect(project.renameLabel({ baseRevision: 0, from: 'sec:a', to: 'sec:b' })).toMatchObject({
			ok: false,
			issues: [{ code: 'READ_ONLY', path: 'b.typ' }],
		})
		expect(project.snapshot().files).toEqual(files)
	})

	it('prepares a human label change without mutation and includes references in the accepted transaction', () => {
		const figure =
			'#figure(image("chart.svg"), caption: [中文题注])\n// keep ownership\n<fig:old>\n本章 @fig:old。'
		const references = '中文 😀 @fig:old 与 @fig:old[图]。'
		const project = createTypstSourceProjectState(
			{ files: { 'figure.typ': figure, 'references.typ': references } },
			parser,
		)
		const projection = project.open('figure.typ')
		const document = structuredClone(projection.document)
		const target = document.content!.find((node) => node.type === 'figure')!
		expect(target).toBeDefined()
		target.attrs!.label = 'fig:renamed'
		const prepared = project.prepareEdit({ projection, document })
		expect(prepared.ok).toBe(true)
		expect(project.revision).toBe(0)
		expect(project.snapshot().files['references.typ']).toBe(references)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		expect(project.apply(prepared.value).ok).toBe(true)
		expect(project.snapshot().files).toEqual({
			'figure.typ': figure.replaceAll('fig:old', 'fig:renamed'),
			'references.typ': references.replaceAll('fig:old', 'fig:renamed'),
		})
		expect(project.undo()).toMatchObject({
			ok: true,
			value: { files: { 'figure.typ': figure, 'references.typ': references } },
		})
	})

	it('refuses the complete human label transaction when a reference file is read-only', () => {
		const files = {
			'figure.typ': '#figure(image("chart.svg"), caption: [Caption]) <fig:old>',
			'refs.typ': '@fig:old',
		}
		const project = createTypstSourceProjectState({ files, writablePaths: ['figure.typ'] }, parser)
		const projection = project.open('figure.typ')
		const document = structuredClone(projection.document)
		document.content!.find((node) => node.type === 'figure')!.attrs!.label = 'fig:new'
		expect(project.prepareEdit({ projection, document })).toMatchObject({
			ok: false,
			issues: [{ code: 'READ_ONLY', path: 'refs.typ' }],
		})
		expect(project.snapshot().files).toEqual(files)
		expect(project.revision).toBe(0)
	})

	it('reuses unaffected file parses while stamping the current revision', () => {
		const tracked = { parse: vi.fn(parse), parseAst: vi.fn(parseAst) }
		const project = createTypstSourceProjectState(
			{ files: { 'a.typ': 'A', 'b.typ': 'B' } },
			tracked,
		)
		project.open('a.typ')
		const count = tracked.parse.mock.calls.length
		project.apply({
			baseRevision: 0,
			patches: [{ path: 'b.typ', from: 0, to: 1, text: 'Changed' }],
		})
		expect(project.open('a.typ').revision).toBe(1)
		expect(tracked.parse).toHaveBeenCalledTimes(count)
	})

	it('isolates authoritative bytes and derived documents from caller mutation', () => {
		const asset = new Uint8Array([1, 2, 3])
		const project = createTypstSourceProjectState(
			{ files: { 'main.typ': 'Original', 'asset.bin': asset } },
			parser,
		)
		asset[0] = 99
		const external = project.snapshot().files['asset.bin'] as Uint8Array
		external[1] = 99
		expect(project.snapshot().files['asset.bin']).toEqual(new Uint8Array([1, 2, 3]))
		const projection = project.open('main.typ')
		projection.document.content = []
		expect(project.open('main.typ').document.content).not.toEqual([])
	})

	it('validates project paths without banning legal relative imports inside source', () => {
		expect(() =>
			createTypstSourceProjectState({ files: { '../escape.typ': 'x' } }, parser),
		).toThrow(TypstSourceProjectError)
		expect(() =>
			createTypstSourceProjectState({ files: { folder: 'x', 'folder/file.typ': 'y' } }, parser),
		).toThrow(TypstSourceProjectError)
		const project = createTypstSourceProjectState(
			{ files: { 'sections/a.typ': '#include "../template.typ"', 'template.typ': 'OK' } },
			parser,
		)
		expect(project.snapshot().files['sections/a.typ']).toBe('#include "../template.typ"')
	})

	it('moves a figure, caption and intervening comment together and rewrites the literal image path', () => {
		const figure =
			'#figure(image("../assets/logo.svg", width: 80%), caption: [营收 *增长*]) /*comment*/ <fig:revenue>'
		const source = `${figure}\n\n本章参见 @fig:revenue。`
		const project = createTypstSourceProjectState(
			{
				files: {
					'sections/a.typ': source,
					'chapters/deep/b.typ': '另章\n',
					'assets/logo.svg': '<svg/>',
				},
			},
			parser,
		)
		const result = project.move({
			baseRevision: 0,
			path: 'sections/a.typ',
			label: 'fig:revenue',
			toPath: 'chapters/deep/b.typ',
			at: bytes('另章\n'),
		})
		expect(result.ok).toBe(true)
		expect(project.snapshot().files['sections/a.typ']).toBe('\n\n本章参见 @fig:revenue。')
		expect(project.snapshot().files['chapters/deep/b.typ']).toContain(
			figure.replace('../assets/logo.svg', '../../assets/logo.svg'),
		)
		expect(project.open('chapters/deep/b.typ').labels).toHaveLength(1)
		expect(project.undo()).toMatchObject({
			ok: true,
			value: { files: { 'sections/a.typ': source, 'chapters/deep/b.typ': '另章\n' } },
		})
	})

	it('copies complete subtrees with fresh labels, rebinding only their internal references', () => {
		const subtree =
			'#figure(image("assets/logo.svg"), caption: [*Caption*]) <fig:chart>\n\nInside @fig:chart and @sec:external.\n'
		const after = '\nOutside @fig:chart.\n= Existing <fig:chart-copy>\n= External <sec:external>'
		const project = createTypstSourceProjectState(
			{ files: { 'main.typ': subtree + after, 'copies/new.typ': '', 'assets/logo.svg': '<svg/>' } },
			parser,
		)
		const result = project.copy({
			baseRevision: 0,
			path: 'main.typ',
			from: 0,
			to: bytes(subtree),
			toPath: 'copies/new.typ',
			at: 0,
		})
		expect(result.ok).toBe(true)
		expect(project.snapshot().files['main.typ']).toBe(subtree + after)
		expect(project.snapshot().files['copies/new.typ']).toContain('<fig:chart-copy-2>')
		expect(project.snapshot().files['copies/new.typ']).toContain(
			'Inside @fig:chart-copy-2 and @sec:external.',
		)
		expect(project.snapshot().files['copies/new.typ']).toContain('image("../assets/logo.svg")')
		expect(project.undo()).toMatchObject({ ok: true, value: { files: { 'copies/new.typ': '' } } })
	})

	it('moves and copies a static figure past unrelated file-local bindings', () => {
		const prefix = '#let sales = json("../data.json")\n'
		const figure = '#figure(image("../asset.svg"), caption: [Caption @sec:notes]) <fig:a>'
		const destination = '#let total = 3\n= Notes <sec:notes>\n'
		const project = createTypstSourceProjectState(
			{
				files: {
					'sections/a.typ': prefix + figure + '\n\nSee @fig:a.',
					'b.typ': destination,
					'asset.svg': '<svg/>',
					'data.json': '{}',
				},
			},
			parser,
		)
		expect(
			project.copy({
				baseRevision: 0,
				path: 'sections/a.typ',
				from: bytes(prefix),
				to: bytes(prefix + figure),
				toPath: 'b.typ',
				at: bytes(destination),
			}),
		).toMatchObject({ ok: true })
		expect(project.snapshot().files['b.typ']).toContain(
			'image("asset.svg"), caption: [Caption @sec:notes]) <fig:a-copy>',
		)
		expect(
			project.move({
				baseRevision: 1,
				path: 'sections/a.typ',
				label: 'fig:a',
				toPath: 'b.typ',
				at: bytes(project.open('b.typ').source),
			}),
		).toMatchObject({ ok: true })
		expect(project.snapshot().files['sections/a.typ']).toBe(prefix + '\n\nSee @fig:a.')
		expect(project.snapshot().files['b.typ']).toContain(
			'image("asset.svg"), caption: [Caption @sec:notes]) <fig:a>',
		)
	})

	it('rejects moving across an environment statement or into a shadowed function scope', () => {
		const figure = '#figure(image("asset.svg"), caption: [Caption]) <fig:a>'
		const source = `${figure}\n#let width = 20pt\nAfter`
		const project = createTypstSourceProjectState(
			{
				files: {
					'a.typ': source,
					'b.typ': '#let image(..args) = [different]\n',
					'asset.svg': '<svg/>',
				},
			},
			parser,
		)
		expect(
			project.move({
				baseRevision: 0,
				path: 'a.typ',
				label: 'fig:a',
				toPath: 'a.typ',
				at: bytes(source),
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'UNSUPPORTED_EDIT' }] })
		expect(
			project.move({
				baseRevision: 0,
				path: 'a.typ',
				label: 'fig:a',
				toPath: 'b.typ',
				at: bytes('#let image(..args) = [different]\n'),
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'UNSUPPORTED_EDIT' }] })
		expect(project.snapshot().files['a.typ']).toBe(source)
		expect(project.revision).toBe(0)
	})

	it('refuses computed resource paths and partial subtree copies without changing either file', () => {
		const source =
			'#let imagePath = "asset.svg"\n#figure(image(imagePath), caption: [Caption]) <fig:a>'
		const project = createTypstSourceProjectState(
			{ files: { 'a.typ': source, 'b.typ': '', 'asset.svg': '<svg/>' } },
			parser,
		)
		expect(
			project.move({ baseRevision: 0, path: 'a.typ', label: 'fig:a', toPath: 'b.typ', at: 0 }),
		).toMatchObject({ ok: false, issues: [{ code: 'UNSUPPORTED_EDIT' }] })
		expect(
			project.copy({
				baseRevision: 0,
				path: 'a.typ',
				from: bytes('#let imagePath = "asset.svg"\n#figure('),
				to: bytes(source),
				toPath: 'b.typ',
				at: 0,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'UNSUPPORTED_EDIT' }] })
		expect(project.snapshot().files['a.typ']).toBe(source)
		expect(project.snapshot().files['b.typ']).toBe('')
	})

	it('renames explicit reference-helper targets using their native label argument syntax', () => {
		const project = createTypstSourceProjectState(
			{
				files: {
					'main.typ': '= Target <sec:old>',
					'refs.typ':
						'#import "lib/pluxel.typ" as report\n#report.reference(<sec:old>, caption: true)',
					'lib/pluxel.typ': typstSourceLibrary,
				},
			},
			parser,
		)
		expect(project.open('refs.typ').references).toEqual([
			expect.objectContaining({ label: 'sec:old', syntax: 'label' }),
		])
		expect(project.renameLabel({ baseRevision: 0, from: 'sec:old', to: 'sec:new' }).ok).toBe(true)
		expect(project.snapshot().files['refs.typ']).toContain(
			'#report.reference(<sec:new>, caption: true)',
		)
	})

	it('invalidates a cached importer when its module source no longer provides the declared helper', () => {
		const project = createTypstSourceProjectState(
			{
				files: {
					'main.typ':
						'#import "lib/pluxel.typ" as report\n#report.reference(<sec:target>, caption: true)',
					'lib/pluxel.typ': typstSourceLibrary,
				},
			},
			parser,
		)
		expect(project.open('main.typ').references).toHaveLength(1)
		expect(
			project.apply({
				baseRevision: 0,
				patches: [
					{
						path: 'lib/pluxel.typ',
						from: 0,
						to: bytes(typstSourceLibrary),
						text: '#let reference(target, caption: auto) = [Different]',
					},
				],
			}).ok,
		).toBe(true)
		expect(project.open('main.typ').references).toEqual([])
		expect(project.open('main.typ').document.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: 'typstSource' })]),
		)
	})
})

describe('declared component transfers', () => {
	const component = {
		module: 'lib/chart.typ',
		name: 'channels',
		label: 'Channels',
		parameters: { title: { type: 'string' as const } },
		data: 'data',
	}
	const module = '#let channels(title: "", data: (:)) = [#title]'
	const imports = '#import "lib/pluxel.typ" as report\n#import "lib/chart.typ" as chart\n\n'
	const figure =
		'#figure(chart.channels(title: "Sales", data: json("data/sales.json")), caption: [Sales *caption*]) /* retain */ <fig:sales>'
	const helper = 'See #report.reference(<fig:sales>, caption: true) and @fig:sales.'
	it('copies a declared component figure and both native reference syntaxes in its original import scope', () => {
		const subtree = figure + '\n\n' + helper,
			source = imports + subtree + '\n\nOutside @fig:sales.\n'
		const files = {
			'main.typ': source,
			'lib/pluxel.typ': typstSourceLibrary,
			'lib/chart.typ': module,
			'data/sales.json': '{"values":[1,2]}',
		}
		const project = createTypstSourceProjectState({ files, components: [component] }, parser)
		expect(
			project.copy({
				baseRevision: 0,
				path: 'main.typ',
				from: bytes(imports),
				to: bytes(imports + subtree),
				toPath: 'main.typ',
				at: bytes(source),
			}),
		).toMatchObject({ ok: true })
		const copied = project.snapshot().files['main.typ'] as string
		expect(copied.slice(0, source.length)).toBe(source)
		expect(copied.slice(source.length)).toContain('<fig:sales-copy>')
		expect(copied.slice(source.length)).toContain(
			'#report.reference(<fig:sales-copy>, caption: true) and @fig:sales-copy.',
		)
		expect(copied.slice(source.length)).toContain('/* retain */')
		expect(
			project.open('main.typ').labels.filter((label) => label.label === 'fig:sales-copy'),
		).toHaveLength(1)
		expect(project.snapshot().files['lib/chart.typ']).toBe(module)
		expect(project.undo()).toMatchObject({ ok: true, value: { files: { 'main.typ': source } } })
		expect(project.redo().ok).toBe(true)
	})
	it('relocates a confirmed component module alias and literal JSON resource across source files', () => {
		const prefix = '#import "../lib/chart.typ" as chart\n#import "../lib/pluxel.typ" as report\n\n'
		const body =
			'#figure(chart.channels(title: "Sales", data: json("../data/sales.json")), caption: [See #report.reference(<sec:methods>, caption: false)]) <fig:sales>'
		const destination =
			'#import "../../lib/chart.typ": channels as draw\n#import "../../lib/pluxel.typ" as refs\n\n'
		const project = createTypstSourceProjectState(
			{
				files: {
					'chapters/report.typ': prefix + body,
					'chapters/nested/appendix.typ': destination,
					'methods.typ': '= Methods <sec:methods>',
					'lib/pluxel.typ': typstSourceLibrary,
					'lib/chart.typ': module,
					'data/sales.json': '{}',
				},
				components: [component],
			},
			parser,
		)
		const result = project.move({
			baseRevision: 0,
			path: 'chapters/report.typ',
			label: 'fig:sales',
			toPath: 'chapters/nested/appendix.typ',
			at: bytes(destination),
		})
		expect(result).toMatchObject({ ok: true })
		expect(project.snapshot().files['chapters/report.typ']).toBe(prefix)
		const moved = project.snapshot().files['chapters/nested/appendix.typ'] as string
		expect(moved).toContain('draw(title: "Sales", data: json("../../data/sales.json"))')
		expect(moved).toContain('#refs.reference(<sec:methods>, caption: false)')
		expect(project.open('chapters/nested/appendix.typ').document.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'figure',
					content: expect.arrayContaining([
						expect.objectContaining({
							type: 'typstComponent',
							attrs: expect.objectContaining({
								module: 'lib/chart.typ',
								binding: expect.objectContaining({ file: 'data/sales.json' }),
							}),
						}),
					]),
				}),
			]),
		)
	})
	it('rejects unconfirmed calls, shadowed imports, computed data paths, and crossed environments without partial writes', () => {
		const variants = [
			{ source: imports + figure, destination: '#import "lib/other.typ" as chart\n' },
			{ source: imports + figure, destination: imports + '#let chart = (channels: x => x)\n' },
			{
				source: imports + figure.replace('json("data/sales.json")', 'json(path)'),
				destination: imports,
			},
			{ source: imports + figure, destination: imports + '#set text(fill: red)\n' },
		]
		for (const value of variants) {
			const files = {
				'a.typ': value.source,
				'b.typ': value.destination,
				'lib/pluxel.typ': typstSourceLibrary,
				'lib/chart.typ': module,
				'lib/other.typ': module,
				'data/sales.json': '{}',
			}
			const project = createTypstSourceProjectState({ files, components: [component] }, parser)
			expect(
				project.move({
					baseRevision: 0,
					path: 'a.typ',
					label: 'fig:sales',
					toPath: 'b.typ',
					at: bytes(value.destination),
				}),
			).toMatchObject({ ok: false, issues: [{ code: 'UNSUPPORTED_EDIT' }] })
			expect(project.snapshot().files).toEqual(files)
		}
		const source = imports + figure + '\n#show figure: it => it\nTail'
		const project = createTypstSourceProjectState(
			{
				files: {
					'main.typ': source,
					'lib/pluxel.typ': typstSourceLibrary,
					'lib/chart.typ': module,
					'data/sales.json': '{}',
				},
				components: [component],
			},
			parser,
		)
		expect(
			project.copy({
				baseRevision: 0,
				path: 'main.typ',
				from: bytes(imports),
				to: bytes(imports + figure),
				toPath: 'main.typ',
				at: bytes(source),
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'UNSUPPORTED_EDIT' }] })
	})
})

it('copies an inline JSON field and LaTeX helper using the original imported provenance', () => {
	const prefix = '#import "lib/pluxel.typ" as report\n\n'
	const body = '#report.field(json("data.json"), ("customer", "name")) text #report.latex("x+1").'
	const source = prefix + body
	const project = createTypstSourceProjectState(
		{
			files: {
				'main.typ': source,
				'lib/pluxel.typ': typstSourceLibrary,
				'data.json': '{"customer":{"name":"客户"}}',
			},
		},
		parser,
	)
	const result = project.copy({
		baseRevision: 0,
		path: 'main.typ',
		from: bytes(prefix),
		to: bytes(source),
		toPath: 'main.typ',
		at: bytes(source),
	})
	expect(result).toMatchObject({ ok: true })
	expect((project.snapshot().files['main.typ'] as string).split(body)).toHaveLength(3)
	expect(project.undo()).toMatchObject({ ok: true, value: { files: { 'main.typ': source } } })
})
