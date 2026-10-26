import { describe, expect, it } from 'vitest'
import { Node, getSchema, type Editor, type JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { history, undo } from '@tiptap/pm/history'
import {
	applyTypstCandidate,
	createTypstExtensions,
	exportTypstMarkdown,
	findTypstGeneratedPosition,
	findTypstRegionPosition,
	generateTypstRegions,
	parseTypstClipboard,
	parseTypstMarkdown,
	prepareTypstCandidate,
	validateTypstDraft,
	validateTypstRegion,
	validateTypstRegions,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'

const config: TypstEditorConfig = {
	regions: [{ id: 'body' }],
	fields: [{ path: ['customer', 'name'], label: 'Customer' }],
}
const data = { customer: { name: '客户😀' } }
const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: text ? [{ type: 'text', text }] : [],
})
const doc = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
const field: JSONContent = { type: 'dataField', attrs: { path: ['customer', 'name'] } }

describe('Typst raw JSON admission', () => {
	it('rejects unknown attributes before ProseMirror can discard them', () => {
		const document = doc({ ...paragraph('Text'), attrs: { authorOnly: true } })
		const result = validateTypstRegion({ document, regionId: 'body', config, data })
		expect(result).toMatchObject({
			ok: false,
			issues: [
				{
					code: 'UNKNOWN_ATTRIBUTE',
					regionId: 'body',
					path: ['content', 0, 'attrs', 'authorOnly'],
				},
			],
		})
		expect(document.content![0]!.attrs!.authorOnly).toBe(true)
		expect(
			validateTypstRegion({
				document: doc({ type: 'rawTypst', attrs: { source: '#eval("...")' } }),
				regionId: 'body',
				config,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'UNKNOWN_NODE' }] })
		expect(
			validateTypstRegion({
				document: doc({
					type: 'paragraph',
					content: [{ type: 'text', text: 'x', marks: [{ type: 'unknown' }] }],
				}),
				regionId: 'body',
				config,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'UNKNOWN_MARK' }] })
	})

	it('checks exact regions, template revision and fields without repairing drafts', () => {
		expect(validateTypstRegions({ regions: {}, config })).toMatchObject({
			ok: false,
			issues: [{ code: 'REGION_SET' }],
		})
		const draft = {
			formatVersion: 1,
			templateId: 'fixed',
			templateRevision: '1',
			data: { amount: '42' },
			regions: { body: doc(paragraph('Text')) },
		}
		expect(
			validateTypstDraft({ draft, config, templateId: 'fixed', templateRevision: '1' }),
		).toMatchObject({ ok: true, value: { data: { amount: '42' } } })
		expect(
			validateTypstDraft({ draft, config, templateId: 'fixed', templateRevision: '2' }),
		).toMatchObject({ ok: false, issues: [{ code: 'TEMPLATE_CONFLICT' }] })
		expect(draft.data.amount).toBe('42')
		expect(
			validateTypstRegion({
				document: doc({ type: 'paragraph', content: [field] }),
				regionId: 'body',
				config,
				data: { customer: { name: null } },
			}),
		).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_FIELD', fieldPath: ['customer', 'name'] }],
		})
		const nullable = { ...config, fields: [{ ...config.fields[0]!, nullText: '未提供' }] }
		expect(
			validateTypstRegion({
				document: doc({ type: 'paragraph', content: [field] }),
				regionId: 'body',
				config: nullable,
				data: { customer: { name: null } },
			}).ok,
		).toBe(true)
		const limited = {
			...config,
			regions: [{ id: 'body', nodes: ['paragraph', 'text'], fields: [] }],
		}
		expect(
			validateTypstRegion({
				document: doc({ type: 'paragraph', content: [field] }),
				regionId: 'body',
				config: limited,
				data,
			}),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([
				expect.objectContaining({ code: 'REGION_RULE' }),
				expect.objectContaining({ code: 'INVALID_FIELD' }),
			]),
		})
	})

	it('validates actual table geometry and conflicting column widths', () => {
		const cell = (attrs: Record<string, unknown> = {}): JSONContent => ({
			type: 'tableCell',
			attrs,
			content: [paragraph('cell')],
		})
		const table = (...rows: JSONContent[][]): JSONContent => ({
			type: 'table',
			content: rows.map((content) => ({ type: 'tableRow', content })),
		})
		expect(
			validateTypstRegion({
				document: doc(table([cell({ rowspan: 2 }), cell()], [cell()])),
				regionId: 'body',
				config,
			}).ok,
		).toBe(true)
		for (const invalid of [
			table([cell(), cell()], [cell()]),
			table([cell({ rowspan: 3 })]),
			table([cell({ colspan: 2, colwidth: [100] })]),
			table([cell({ colwidth: [100] })], [cell({ colwidth: [200] })]),
		]) {
			expect(
				validateTypstRegion({ document: doc(invalid), regionId: 'body', config }),
			).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_TABLE' })]),
			})
		}
	})

	it('rejects malformed raw content and unpaired surrogates without discarding or repairing input', () => {
		const malformed = { type: 'doc', content: [{ type: 'table', content: [null] }] }
		expect(validateTypstRegion({ document: malformed, regionId: 'body', config })).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_JSON' }],
		})
		const circular: { type: string; content?: unknown[] } = { type: 'doc' }
		circular.content = [circular]
		expect(validateTypstRegion({ document: circular, regionId: 'body', config })).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_JSON' }],
		})
		expect(
			validateTypstRegion({ document: doc(paragraph('\ud800')), regionId: 'body', config }),
		).toMatchObject({ ok: false, issues: [{ code: 'INVALID_STRUCTURE' }] })
		expect(
			generateTypstRegions({
				regions: { body: doc(paragraph('Text')) },
				config,
				data: { value: '\udfff' },
				snapshotRevision: 1,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'INVALID_DATA' }] })
	})

	it('rejects child content on text nodes before draft admission or lossless Markdown export', () => {
		const document = doc({
			type: 'paragraph',
			content: [{ type: 'text', text: 'Visible', content: [{ type: 'text', text: 'Keep me' }] }],
		})
		const original = structuredClone(document)
		const rejected = {
			ok: false,
			issues: [{ code: 'INVALID_STRUCTURE', path: ['content', 0, 'content', 0, 'content'] }],
		}
		expect(
			validateTypstDraft({
				draft: {
					formatVersion: 1,
					templateId: 'fixed',
					templateRevision: '1',
					data,
					regions: { body: document },
				},
				config,
				templateId: 'fixed',
				templateRevision: '1',
			}),
		).toMatchObject(rejected)
		expect(exportTypstMarkdown({ document, regionId: 'body', config })).toMatchObject(rejected)
		expect(document).toEqual(original)
	})

	it('uses native extension structure plus explicit attribute and output mappings', () => {
		const Notice = Node.create({
			name: 'notice',
			group: 'block',
			content: 'block+',
			addAttributes: () => ({ tone: { default: 'note' } }),
		})
		expect(
			validateTypstRegion({
				document: doc({ type: 'notice', content: [paragraph('Hello')] }),
				regionId: 'body',
				config: { ...config, extensions: [Notice] },
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'MISSING_SERIALIZER' }] })
		const extended: TypstEditorConfig = {
			...config,
			extensions: [Notice],
			nodeMappings: {
				notice: {
					validateAttributes: (attrs) => attrs.tone === 'note',
					serialize: (node, context) => `#block[${context.children(node)}]`,
				},
			},
		}
		expect(
			generateTypstRegions({
				regions: {
					body: doc({ type: 'notice', attrs: { tone: 'note' }, content: [paragraph('Hello')] }),
				},
				config: extended,
				data,
				snapshotRevision: 3,
			}),
		).toMatchObject({
			ok: true,
			value: {
				templateFiles: {
					'_editor/regions/body.typ': expect.stringContaining('#block[#par[#text("Hello")]'),
				},
			},
		})
		expect(
			validateTypstRegion({
				document: doc(paragraph('x')),
				regionId: 'body',
				config: { ...extended, extensions: [Notice, Notice] },
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'INVALID_CONFIG' }] })
	})
})

describe('portable Markdown and generated mapping', () => {
	it('parses fields, GFM tables and literal code without a DOM or an Editor', () => {
		expect(typeof globalThis.document).toBe('undefined')
		const markdown =
			'# Title\n\nClient <data-field path=\'["customer","name"]\'></data-field>.\n\n| Name | Value |\n| --- | --- |\n| Pipe \\| text | 42 |\n\n`<data-field path=\'["bad"]\'></data-field>`\n\n```html\n<data-field path=\'["bad"]\'></data-field>\n```'
		const parsed = parseTypstMarkdown({ markdown, regionId: 'body', config, data })
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
		expect(parsed.value.content!.map((node) => node.type)).toEqual([
			'heading',
			'paragraph',
			'table',
			'paragraph',
			'codeBlock',
		])
		expect(parsed.value.content![1]!.content).toContainEqual(field)
		expect(JSON.stringify(parsed.value.content![2])).toContain('Pipe | text')
		expect(
			parseTypstMarkdown({
				markdown: '<data-field path=\'["customer","name"]\'></data-field>',
				regionId: 'body',
				config,
				data,
			}),
		).toMatchObject({ ok: true, value: { content: [{ type: 'paragraph', content: [field] }] } })
		expect(
			parseTypstMarkdown({
				markdown: 'Hello <business-node value="lost"></business-node>',
				regionId: 'body',
				config,
			}),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_MARKDOWN' })]),
		})
		expect(
			parseTypstMarkdown({
				markdown: 'Hello <data-field path=\'["secret"]\'></data-field>',
				regionId: 'body',
				config,
				data,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'INVALID_FIELD' }] })
		expect(parseTypstClipboard({ text: '**Literal**', regionId: 'body', config })).toEqual({
			ok: true,
			value: doc(paragraph('**Literal**')),
		})
		const codePaste = parseTypstClipboard({
			text: '```\n| x | y |\n| --- | --- |\n```',
			regionId: 'body',
			config,
		})
		expect(
			codePaste.ok && codePaste.value.content!.every((node) => node.type === 'paragraph'),
		).toBe(true)
	})

	it('reports lossy Markdown and protects complex JSON', () => {
		const document = doc({ type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, field] })
		expect(exportTypstMarkdown({ document, regionId: 'body', config, data })).toMatchObject({
			ok: true,
			value: { lossless: true },
		})
		const merged = doc({
			type: 'table',
			content: [
				{
					type: 'tableRow',
					content: [
						{
							type: 'tableCell',
							attrs: { colspan: 2, colwidth: [120, 240] },
							content: [paragraph('first'), paragraph('second')],
						},
					],
				},
			],
		})
		expect(exportTypstMarkdown({ document: merged, regionId: 'body', config })).toMatchObject({
			ok: true,
			value: {
				lossless: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'COMPLEX_CONTENT' })]),
			},
		})
		expect(merged.content![0]!.content![0]!.content![0]!.content).toHaveLength(2)
	})

	it('maps escaped literals and UTF-16 characters without splitting text shaping', () => {
		const result = generateTypstRegions({
			regions: { body: doc(paragraph('A"\\\t\n😀Z'), paragraph('Next')) },
			config,
			data,
			snapshotRevision: 'draft-1',
		})
		if (!result.ok) throw new Error('generation failed')
		const { mapping, templateFiles } = result.value
		const source = templateFiles['_editor/regions/body.typ']!
		expect(source.match(/#text\(/g)).toHaveLength(2)
		expect(source).not.toContain('pluxel-editor-map')
		const characters = mapping.filter((entry) => entry.kind === 'text' && entry.from < 9)
		expect(
			characters.map((entry) => [
				entry.from,
				entry.to,
				source.slice(entry.startOffset, entry.endOffset),
			]),
		).toEqual([
			[1, 2, 'A'],
			[2, 3, '\\"'],
			[3, 4, '\\\\'],
			[4, 5, '\\t'],
			[5, 6, '\\n'],
			[6, 8, '😀'],
			[8, 9, 'Z'],
		])
		for (const entry of characters) {
			expect(
				findTypstRegionPosition({
					mapping,
					position: { path: entry.path, ...entry.range.start },
					snapshotRevision: 'draft-1',
				}),
			).toEqual({ regionId: 'body', from: entry.from, to: entry.to })
		}
		const last = characters.at(-1)!
		const first = characters[0]!
		const glyph = (entry: typeof last) => ({
			path: entry.path,
			...entry.range.start,
			endLine: entry.range.end.line,
			endColumn: entry.range.end.column,
			page: 1,
			x: 0,
			y: 0,
			width: 5,
			height: 10,
		})
		const navigation = { pages: [], outline: [], points: [glyph(first), glyph(last)] }
		expect(
			findTypstGeneratedPosition({
				mapping,
				navigation,
				regionId: 'body',
				position: 8,
				snapshotRevision: 'draft-1',
			}),
		).toEqual({ path: last.path, ...last.range.start })
		expect(
			findTypstGeneratedPosition({
				mapping,
				navigation,
				regionId: 'body',
				position: 9,
				snapshotRevision: 'draft-1',
			}),
		).toEqual({ path: last.path, ...last.range.start })
		expect(
			findTypstGeneratedPosition({
				mapping,
				navigation,
				regionId: 'body',
				position: 8,
				snapshotRevision: 'draft-2',
			}),
		).toBeUndefined()
		expect(
			findTypstGeneratedPosition({
				mapping,
				navigation: { ...navigation, points: [] },
				regionId: 'body',
				position: 8,
				snapshotRevision: 'draft-1',
			}),
		).toBeUndefined()
		expect(
			findTypstRegionPosition({
				mapping,
				position: { path: first.path, line: 3, column: 1 },
				snapshotRevision: 'draft-1',
			}),
		).toEqual({ regionId: 'body', from: 11, to: 15 })
		expect(
			findTypstRegionPosition({
				mapping,
				position: { path: first.path, ...first.range.start },
				snapshotRevision: 'draft-2',
			}),
		).toBeUndefined()
	})

	it('selects a native ligature span and the nearest rendered character for whitespace', () => {
		const result = generateTypstRegions({
			regions: { body: doc(paragraph('ffi  Z')) },
			config,
			data,
			snapshotRevision: 1,
		})
		if (!result.ok) throw new Error('generation failed')
		const mapping = result.value.mapping
		const letters = mapping.filter((entry) => entry.kind === 'text')
		const first = letters[0]!
		const last = letters.at(-1)!
		const navigation = {
			pages: [],
			outline: [],
			points: [
				{
					path: first.path,
					...first.range.start,
					endLine: letters[2]!.range.end.line,
					endColumn: letters[2]!.range.end.column,
					page: 1,
					x: 0,
					y: 0,
					width: 12,
					height: 10,
				},
				{
					path: last.path,
					...last.range.start,
					endLine: last.range.end.line,
					endColumn: last.range.end.column,
					page: 1,
					x: 25,
					y: 0,
					width: 5,
					height: 10,
				},
			],
		}
		expect(
			findTypstGeneratedPosition({
				mapping,
				navigation,
				regionId: 'body',
				position: 3,
				snapshotRevision: 1,
			}),
		).toEqual({ path: first.path, ...first.range.start })
		expect(
			findTypstGeneratedPosition({
				mapping,
				navigation,
				regionId: 'body',
				position: 5,
				snapshotRevision: 1,
			}),
		).toEqual({ path: last.path, ...last.range.start })
	})

	it('retains native positions through nested lists, table cells, marks and repeated custom children', () => {
		const Repeat = Node.create({ name: 'repeat', group: 'block', content: 'block+' })
		const extended: TypstEditorConfig = {
			...config,
			extensions: [Repeat],
			nodeMappings: {
				repeat: {
					serialize(node, context) {
						const once = context.children(node)
						return `#block[${once}${context.children(node)}${once}]`
					},
				},
			},
		}
		const same = paragraph('Same')
		const document = doc({
			type: 'repeat',
			content: [
				same,
				same,
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [
								paragraph('List'),
								{
									type: 'orderedList',
									content: [{ type: 'listItem', content: [paragraph('Nested')] }],
								},
							],
						},
					],
				},
				{
					type: 'table',
					content: [
						{
							type: 'tableRow',
							content: [
								{
									type: 'tableCell',
									content: [
										{
											type: 'paragraph',
											content: [{ type: 'text', text: 'Cell', marks: [{ type: 'bold' }] }, field],
										},
									],
								},
							],
						},
					],
				},
			],
		})
		const result = generateTypstRegions({
			regions: { body: document },
			config: extended,
			data,
			snapshotRevision: 1,
		})
		if (!result.ok) throw new Error(JSON.stringify(result.issues))
		const { mapping, templateFiles } = result.value
		const source = templateFiles['_editor/regions/body.typ']!
		const native = getSchema(createTypstExtensions(extended)).nodeFromJSON(document)
		const expected: { from: number; to: number; text?: string }[] = []
		native.descendants((node, position) => {
			if (node.isText) {
				let offset = position
				for (const character of node.text!) {
					expected.push({ from: offset, to: offset + character.length, text: character })
					offset += character.length
				}
			} else if (node.type.name === 'dataField') expected.push({ from: position, to: position + 1 })
		})
		for (const target of expected) {
			const copies = mapping.filter(
				(entry) =>
					entry.kind === (target.text ? 'text' : 'atom') &&
					entry.from === target.from &&
					entry.to === target.to,
			)
			expect(copies).toHaveLength(3)
			for (const copy of copies) {
				expect(
					findTypstRegionPosition({
						mapping,
						position: { path: copy.path, ...copy.range.start },
						snapshotRevision: 1,
					}),
				).toEqual({ regionId: 'body', from: target.from, to: target.to })
			}
		}
		expect(source).not.toContain('pluxel-editor-map')
	})
})

describe('candidate commit ownership', () => {
	function stateEditor(document: JSONContent) {
		const schema = getSchema(createTypstExtensions(config))
		let state = EditorState.create({
			schema,
			doc: schema.nodeFromJSON(document),
			plugins: [history()],
		})
		let dispatches = 0
		const dispatch = (transaction: Parameters<typeof state.apply>[0]) => {
			state = state.apply(transaction)
			dispatches++
		}
		// No DOM: the harness supplies only native EditorState/history and dispatch.
		const editor = {
			schema,
			get state() {
				return state
			},
			getJSON: () => state.doc.toJSON(),
			view: { dispatch },
		} as unknown as Editor
		return {
			editor,
			dispatch,
			get dispatches() {
				return dispatches
			},
		}
	}
	it('accepts a complete candidate in one transaction and one undo restores the original', () => {
		const initial = doc(paragraph('Original'))
		const fixture = stateEditor(initial)
		const baseline = fixture.editor.getJSON()
		const candidate = prepareTypstCandidate({
			candidate: { regionId: 'body', baseRevision: 1, markdown: '**Replacement**' },
			currentRevision: 1,
			document: initial,
			config,
			data,
			canEdit: () => true,
		})
		expect(candidate.ok).toBe(true)
		if (!candidate.ok) throw new Error(JSON.stringify(candidate.issues))
		expect(
			applyTypstCandidate({
				candidate: candidate.value,
				editor: fixture.editor,
				regionId: 'body',
				currentRevision: () => 1,
				config,
				data: () => data,
				canEdit: () => true,
			}).ok,
		).toBe(true)
		expect(fixture.dispatches).toBe(1)
		expect(fixture.editor.state.doc.textContent).toBe('Replacement')
		expect(undo(fixture.editor.state, fixture.dispatch)).toBe(true)
		expect(fixture.editor.getJSON()).toEqual(baseline)
	})

	it('keeps the current document for forbidden, stale and malformed candidates', () => {
		const initial = doc(paragraph('Original'))
		for (const currentRevision of [2, 'new-template', 'data-edited'])
			expect(
				prepareTypstCandidate({
					candidate: { regionId: 'body', baseRevision: 1, markdown: 'new' },
					currentRevision,
					document: initial,
					config,
					canEdit: () => true,
				}),
			).toMatchObject({ ok: false, issues: [{ code: 'STALE_CANDIDATE' }] })
		expect(
			prepareTypstCandidate({
				candidate: { regionId: 'body', baseRevision: 1, markdown: 'new' },
				currentRevision: 1,
				document: initial,
				config,
				canEdit: () => false,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'FORBIDDEN_REGION' }] })
		const fixture = stateEditor(initial)
		const baseline = fixture.editor.getJSON()
		const prepared = prepareTypstCandidate({
			candidate: { regionId: 'body', baseRevision: 1, markdown: 'new' },
			currentRevision: 1,
			document: initial,
			config,
			canEdit: () => true,
		})
		if (!prepared.ok) throw new Error('candidate fixture failed')
		expect(
			applyTypstCandidate({
				candidate: prepared.value,
				editor: fixture.editor,
				regionId: 'body',
				currentRevision: () => 2,
				config,
				canEdit: () => true,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'STALE_CANDIDATE' }] })
		expect(fixture.dispatches).toBe(0)
		expect(fixture.editor.getJSON()).toEqual(baseline)
	})

	it('rejects text child content in a prepared candidate without dispatching a lossy replacement', () => {
		const initial = doc(paragraph('Original'))
		const fixture = stateEditor(initial)
		const baseline = fixture.editor.getJSON()
		expect(
			applyTypstCandidate({
				candidate: {
					regionId: 'body',
					baseRevision: 1,
					markdown: 'Visible',
					mergedDocument: initial,
					document: doc({
						type: 'paragraph',
						content: [
							{ type: 'text', text: 'Visible', content: [{ type: 'text', text: 'Keep me' }] },
						],
					}),
				},
				editor: fixture.editor,
				regionId: 'body',
				currentRevision: () => 1,
				config,
				canEdit: () => true,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'INVALID_STRUCTURE' }] })
		expect(fixture.dispatches).toBe(0)
		expect(fixture.editor.getJSON()).toEqual(baseline)
	})

	it('reports native editor transaction rejection without claiming a commit', () => {
		const initial = doc(paragraph('Original'))
		const fixture = stateEditor(initial)
		const baseline = fixture.editor.getJSON()
		const prepared = prepareTypstCandidate({
			candidate: { regionId: 'body', baseRevision: 1, markdown: 'New' },
			currentRevision: 1,
			document: initial,
			config,
			canEdit: () => true,
		})
		if (!prepared.ok) throw new Error('candidate fixture failed')
		fixture.editor.view.dispatch = () => {}
		expect(
			applyTypstCandidate({
				candidate: prepared.value,
				editor: fixture.editor,
				regionId: 'body',
				currentRevision: () => 1,
				config,
				canEdit: () => true,
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'REGION_RULE' }] })
		expect(fixture.editor.getJSON()).toEqual(baseline)
	})
})

describe('operation-scoped validation preparation', () => {
	it('prepares the schema once for all regions and generation, rechecking a later changed config', () => {
		let preparations = 0
		const marker = Node.create({
			name: 'preparationMarker',
			group: 'block',
			atom: true,
			addAttributes: () => {
				preparations++
				return { label: { default: 'marker' } }
			},
		})
		const rules: TypstEditorConfig = {
			regions: [{ id: 'one' }, { id: 'two' }],
			fields: [],
			extensions: [marker],
			nodeMappings: {
				preparationMarker: { validateAttributes: () => true, serialize: () => '#text[marker]' },
			},
		}
		const content = doc(paragraph('Text'))
		expect(validateTypstRegion({ document: content, regionId: 'one', config: rules }).ok).toBe(true)
		const once = preparations
		preparations = 0
		expect(
			validateTypstRegions({ regions: { one: content, two: content }, config: rules }).ok,
		).toBe(true)
		expect(preparations).toBe(once)
		preparations = 0
		expect(
			generateTypstRegions({
				regions: { one: content, two: content },
				config: rules,
				data: {},
				snapshotRevision: 1,
			}).ok,
		).toBe(true)
		expect(preparations).toBe(once)
		rules.nodeMappings = {}
		expect(
			validateTypstRegions({ regions: { one: content, two: content }, config: rules }),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'MISSING_SERIALIZER' })]),
		})
	})
})
