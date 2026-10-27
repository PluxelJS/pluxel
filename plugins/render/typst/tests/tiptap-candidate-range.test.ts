import { describe, expect, it } from 'vitest'
import { Node, getSchema, type Editor, type JSONContent } from '@tiptap/core'
import {
	AllSelection,
	EditorState,
	NodeSelection,
	TextSelection,
	type Selection,
} from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { history, undo } from '@tiptap/pm/history'
import {
	applyTypstCandidate,
	captureTypstCandidateTarget,
	createTypstExtensions,
	prepareTypstCandidate,
	TypstTableStyle,
	type TypstEditorConfig,
	type TypstMarkdownCandidate,
} from '../src/tiptap/index.js'

const config: TypstEditorConfig = {
	regions: [{ id: 'body' }],
	fields: [{ path: ['company'], label: 'Company' }],
	extensions: [TypstTableStyle],
}
const data = { company: 'Acme' }
const paragraph = (text: string): JSONContent => ({
	type: 'paragraph',
	content: [{ type: 'text', text }],
})
const table: JSONContent = {
	type: 'table',
	attrs: { tableStyle: 'three-line' },
	content: [
		{
			type: 'tableRow',
			content: [
				{ type: 'tableHeader', content: [paragraph('Channel')] },
				{ type: 'tableHeader', content: [paragraph('Actual')] },
			],
		},
		{
			type: 'tableRow',
			content: [
				{ type: 'tableCell', content: [paragraph('Direct')] },
				{ type: 'tableCell', content: [paragraph('120')] },
			],
		},
	],
}

describe('candidate target capture from native selections', () => {
	const schema = getSchema(createTypstExtensions(config))
	const doc = schema.nodeFromJSON({
		type: 'doc',
		content: [
			paragraph('First'),
			paragraph('Second'),
			{ type: 'blockquote', content: [paragraph('Nested'), paragraph('More')] },
			table,
			{ type: 'horizontalRule' },
		],
	})
	const offsets: number[] = []
	doc.forEach((_node, offset) => offsets.push(offset))
	const capture = (selection: Selection, scope: 'region' | 'blocks' = 'blocks') => {
		const before = selection.toJSON()
		const result = captureTypstCandidateTarget({
			selection,
			regionId: 'body',
			baseRevision: 'fixed:7',
			scope,
		})
		expect(selection.toJSON()).toEqual(before)
		return result
	}
	it('expands cursors/characters, excludes a boundary end, and captures identity atomically', () => {
		for (const selection of [
			TextSelection.create(doc, 2),
			TextSelection.create(doc, 2, offsets[1]!),
		])
			expect(capture(selection)).toEqual({
				ok: true,
				value: {
					regionId: 'body',
					baseRevision: 'fixed:7',
					range: { from: 0, to: offsets[1] },
				},
			})
		expect(capture(TextSelection.create(doc, 2, offsets[1]! + 2))).toMatchObject({
			value: { range: { from: 0, to: offsets[2] } },
		})
		expect(capture(TextSelection.create(doc, offsets[1]!))).toMatchObject({
			value: { range: { from: offsets[1], to: offsets[2] } },
		})
		expect(capture(TextSelection.create(doc, doc.content.size))).toMatchObject({
			value: { range: { from: offsets[4], to: doc.content.size } },
		})
		expect(capture(TextSelection.create(doc, 2), 'region')).toEqual({
			ok: true,
			value: { regionId: 'body', baseRevision: 'fixed:7' },
		})
	})
	it('captures the closest block container and safely widens multi-cell selections', () => {
		expect(capture(TextSelection.create(doc, offsets[2]! + 3))).toMatchObject({
			value: {
				range: {
					from: offsets[2]! + 1,
					to: offsets[2]! + 1 + doc.child(2).child(0).nodeSize,
				},
			},
		})
		const cells: number[] = []
		doc.descendants((node, at) => {
			if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') cells.push(at)
		})
		for (const selection of [
			CellSelection.create(doc, cells[0]!, cells.at(-1)!),
			CellSelection.create(doc, cells.at(-1)!, cells[0]!),
			NodeSelection.create(doc, offsets[3]!),
		])
			expect(capture(selection)).toMatchObject({
				value: { range: { from: offsets[3], to: offsets[4] } },
			})
		for (const selection of [
			TextSelection.create(doc, cells[0]! + 2),
			CellSelection.create(doc, cells[0]!),
		])
			expect(capture(selection)).toMatchObject({
				value: {
					range: { from: cells[0]! + 1, to: cells[0]! + doc.nodeAt(cells[0]!)!.nodeSize - 1 },
				},
			})
		expect(capture(NodeSelection.create(doc, offsets[4]!))).toMatchObject({
			value: { range: { from: offsets[4], to: doc.content.size } },
		})
		expect(capture(new AllSelection(doc))).toMatchObject({
			value: { range: { from: 0, to: doc.content.size } },
		})
		expect(capture(new AllSelection(schema.nodes.doc!.create()))).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_CANDIDATE_RANGE' }],
		})
	})
})

function fixture() {
	const schema = getSchema(createTypstExtensions(config))
	let state = EditorState.create({
		schema,
		doc: schema.nodeFromJSON({
			type: 'doc',
			content: [
				table,
				paragraph('Original analysis'),
				paragraph('Original recommendation'),
				{
					type: 'paragraph',
					content: [{ type: 'dataField', attrs: { path: ['company'] } }],
				},
			],
		}),
		plugins: [history()],
	})
	let dispatches = 0
	const dispatch = (transaction: Parameters<typeof state.apply>[0]) => {
		state = state.apply(transaction)
		dispatches++
	}
	const editor = {
		schema,
		get state() {
			return state
		},
		getJSON: () => state.doc.toJSON(),
		view: { dispatch },
	} as unknown as Editor
	const from = state.doc.child(0).nodeSize
	const to = from + state.doc.child(1).nodeSize + state.doc.child(2).nodeSize
	const candidate: TypstMarkdownCandidate = {
		regionId: 'body',
		baseRevision: 7,
		markdown:
			'## Updated analysis\n\nRevenue **exceeded** target.\n\nImprove subscription conversion.',
		range: { from, to },
	}
	return {
		editor,
		dispatch,
		candidate,
		get dispatches() {
			return dispatches
		},
		prepareOptions: {
			candidate,
			currentRevision: 7,
			document: editor.getJSON(),
			config,
			data,
			canEdit: () => true,
		},
		applyOptions: {
			editor,
			regionId: 'body',
			currentRevision: () => 7,
			config,
			data: () => data,
			canEdit: () => true,
		},
	}
}

describe('scoped Markdown candidates', () => {
	it('replaces complete text blocks beside a styled table, preserving other nodes and one undo', () => {
		const f = fixture()
		const initial = f.editor.getJSON()
		const prepared = prepareTypstCandidate(f.prepareOptions)
		expect(prepared.ok).toBe(true)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		expect(prepared.value.document.content).toHaveLength(3)
		expect(applyTypstCandidate({ ...f.applyOptions, candidate: prepared.value })).toEqual({
			ok: true,
			value: undefined,
		})
		const content = f.editor.getJSON().content!
		expect(f.editor.getJSON()).toEqual(prepared.value.mergedDocument)
		expect(content).toHaveLength(5)
		expect(content[0]).toEqual(initial.content![0])
		expect(content[4]).toEqual(initial.content![3])
		expect(content[1]?.type).toBe('heading')
		expect(content[2]?.content?.[1]).toMatchObject({
			text: 'exceeded',
			marks: [{ type: 'bold' }],
		})
		expect(f.dispatches).toBe(1)
		expect(undo(f.editor.state, f.dispatch)).toBe(true)
		expect(f.editor.getJSON()).toEqual(initial)
	})

	it('continues to reject whole-region replacement and ranges containing styled content', () => {
		const f = fixture()
		for (const range of [undefined, { from: 0, to: f.candidate.range!.to }]) {
			expect(
				prepareTypstCandidate({
					...f.prepareOptions,
					candidate: { ...f.candidate, range },
				}),
			).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'COMPLEX_CONTENT' })]),
			})
		}
		expect(f.dispatches).toBe(0)
	})

	it('rejects empty, partial, noninteger and out-of-bounds ranges at both boundaries', () => {
		const f = fixture()
		const prepared = prepareTypstCandidate(f.prepareOptions)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		for (const range of [
			{ from: 0, to: 0 },
			{ from: f.candidate.range!.from + 1, to: f.candidate.range!.to },
			{ from: 4, to: 12 },
			{ from: 0.5, to: f.candidate.range!.to },
			{ from: 0, to: f.editor.state.doc.content.size + 1 },
			{ from: -1, to: 1 },
			{ from: Number.NaN, to: 1 },
			{ from: f.candidate.range!.to, to: f.candidate.range!.from },
			null,
		] as TypstMarkdownCandidate['range'][]) {
			expect(
				prepareTypstCandidate({
					...f.prepareOptions,
					candidate: { ...f.candidate, range },
				}),
			).toMatchObject({ ok: false, issues: [{ code: 'INVALID_CANDIDATE_RANGE' }] })
			expect(
				applyTypstCandidate({ ...f.applyOptions, candidate: { ...prepared.value, range } }),
			).toMatchObject({ ok: false, issues: [{ code: 'INVALID_CANDIDATE_RANGE' }] })
		}
		expect(f.dispatches).toBe(0)
	})

	it('rechecks the revision and permissions without remapping or widening a prepared range', () => {
		const f = fixture()
		const initial = f.editor.getJSON()
		const prepared = prepareTypstCandidate(f.prepareOptions)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		for (const [currentRevision, canEdit, code] of [
			[8, () => true, 'STALE_CANDIDATE'],
			[7, () => false, 'FORBIDDEN_REGION'],
		] as const) {
			expect(
				prepareTypstCandidate({ ...f.prepareOptions, currentRevision, canEdit }),
			).toMatchObject({ ok: false, issues: [{ code }] })
			expect(
				applyTypstCandidate({
					...f.applyOptions,
					candidate: prepared.value,
					currentRevision: () => currentRevision,
					canEdit,
				}),
			).toMatchObject({ ok: false, issues: [{ code }] })
		}
		expect(f.dispatches).toBe(0)
		expect(f.editor.getJSON()).toEqual(initial)
	})

	it('checks existing target content again at commit and keeps newly styled text', () => {
		const f = fixture()
		const prepared = prepareTypstCandidate(f.prepareOptions)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		const from = f.candidate.range!.from + 1
		f.dispatch(
			f.editor.state.tr.addMark(
				from,
				from + 8,
				f.editor.schema.marks.textStyle!.create({ color: '#ff0000' }),
			),
		)
		const styled = f.editor.getJSON()
		expect(applyTypstCandidate({ ...f.applyOptions, candidate: prepared.value })).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'COMPLEX_CONTENT' })]),
		})
		expect(f.dispatches).toBe(1)
		expect(f.editor.getJSON()).toEqual(styled)
	})

	it('validates replacement rules and the full document, including fields outside the range', () => {
		const f = fixture()
		const prepared = prepareTypstCandidate(f.prepareOptions)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		const noHeadings: TypstEditorConfig = {
			...config,
			regions: [
				{
					id: 'body',
					nodes: [
						'doc',
						'paragraph',
						'text',
						'dataField',
						'table',
						'tableRow',
						'tableHeader',
						'tableCell',
					],
				},
			],
		}
		expect(prepareTypstCandidate({ ...f.prepareOptions, config: noHeadings })).toMatchObject({
			ok: false,
			issues: [{ code: 'REGION_RULE' }],
		})
		expect(
			applyTypstCandidate({ ...f.applyOptions, candidate: prepared.value, config: noHeadings }),
		).toMatchObject({ ok: false, issues: [{ code: 'REGION_RULE' }] })
		expect(prepareTypstCandidate({ ...f.prepareOptions, data: {} })).toMatchObject({
			ok: false,
			issues: [{ code: 'INVALID_FIELD' }],
		})
		expect(
			applyTypstCandidate({ ...f.applyOptions, candidate: prepared.value, data: () => ({}) }),
		).toMatchObject({ ok: false, issues: [{ code: 'INVALID_FIELD' }] })
		expect(f.dispatches).toBe(0)
	})

	it('does not apply stale positions when a host callback changes the editor during admission', () => {
		const f = fixture()
		const prepared = prepareTypstCandidate(f.prepareOptions)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		let checks = 0
		expect(
			applyTypstCandidate({
				...f.applyOptions,
				candidate: prepared.value,
				canEdit: () => {
					if (++checks === 2)
						f.dispatch(f.editor.state.tr.insertText('Host change ', f.candidate.range!.from + 1))
					return true
				},
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'STALE_CANDIDATE' }] })
		expect(f.dispatches).toBe(1)
		expect(f.editor.state.doc.textContent).toContain('Host change Original analysis')
	})
})

const Notice = Node.create({
	name: 'notice',
	group: 'block',
	content: 'block+',
	addAttributes: () => ({ tone: { default: 'warning' } }),
})
const nestedConfig: TypstEditorConfig = {
	...config,
	extensions: [...config.extensions!, Notice],
	nodeMappings: {
		notice: {
			validateAttributes: (attrs) => attrs.tone === 'warning',
			serialize: (node, context) => context.children(node),
		},
	},
}

function nestedFixture() {
	const schema = getSchema(createTypstExtensions(nestedConfig))
	const nestedTable: JSONContent = {
		type: 'table',
		attrs: { tableStyle: 'three-line' },
		content: [
			{
				type: 'tableRow',
				content: [
					{
						type: 'tableHeader',
						attrs: { colspan: 2, colwidth: [120, 180] },
						content: [paragraph('Combined header')],
					},
				],
			},
			{
				type: 'tableRow',
				content: [
					{
						type: 'tableCell',
						attrs: { colwidth: [120] },
						content: [paragraph('Cell intro'), paragraph('Cell detail')],
					},
					{
						type: 'tableCell',
						attrs: { colwidth: [180] },
						content: [paragraph('Neighbor cell')],
					},
				],
			},
		],
	}
	let state = EditorState.create({
		schema,
		doc: schema.nodeFromJSON({
			type: 'doc',
			content: [
				paragraph('Before'),
				nestedTable,
				{
					type: 'notice',
					attrs: { tone: 'warning' },
					content: [
						{
							type: 'paragraph',
							content: [
								{
									type: 'text',
									text: 'Notice intro',
									marks: [{ type: 'textStyle', attrs: { color: '#f00' } }],
								},
							],
						},
						paragraph('Notice detail'),
					],
				},
				{
					type: 'bulletList',
					content: [
						{ type: 'listItem', content: [paragraph('List intro'), paragraph('List detail')] },
					],
				},
				paragraph('After'),
			],
		}),
		plugins: [history()],
	})
	let dispatches = 0
	const dispatch = (transaction: Parameters<typeof state.apply>[0]) => {
		state = state.apply(transaction)
		dispatches++
	}
	const editor = {
		schema,
		get state() {
			return state
		},
		getJSON: () => state.doc.toJSON(),
		view: { dispatch },
	} as unknown as Editor
	const find = (type: string, text?: string) => {
		let at = -1
		state.doc.descendants((node, position) => {
			if (node.type.name === type && (text === undefined || node.textContent === text))
				at = position
		})
		if (at < 0) throw new Error(`Missing fixture node: ${type} ${text ?? ''}`)
		return { at, node: state.doc.nodeAt(at)! }
	}
	const prepare = (candidate: TypstMarkdownCandidate) =>
		prepareTypstCandidate({
			candidate,
			currentRevision: 7,
			document: editor.getJSON(),
			config: nestedConfig,
			data,
			canEdit: () => true,
		})
	return {
		editor,
		dispatch,
		find,
		prepare,
		get dispatches() {
			return dispatches
		},
		applyOptions: {
			editor,
			regionId: 'body',
			currentRevision: () => 7,
			config: nestedConfig,
			data: () => data,
			canEdit: () => true,
		},
	}
}

describe('candidates inside native block containers', () => {
	it('captures a paragraph within a cell, notice or list item and all content of one selected cell', () => {
		const f = nestedFixture()
		for (const text of ['Cell detail', 'Notice intro', 'List detail']) {
			const target = f.find('paragraph', text)
			const selection = TextSelection.create(f.editor.state.doc, target.at + 2)
			expect(
				captureTypstCandidateTarget({
					selection,
					regionId: 'body',
					baseRevision: 7,
					scope: 'blocks',
				}),
			).toEqual({
				ok: true,
				value: {
					regionId: 'body',
					baseRevision: 7,
					range: { from: target.at, to: target.at + target.node.nodeSize },
				},
			})
		}
		const cell = f.find('tableCell', 'Cell introCell detail')
		expect(
			captureTypstCandidateTarget({
				selection: CellSelection.create(f.editor.state.doc, cell.at),
				regionId: 'body',
				baseRevision: 7,
				scope: 'blocks',
			}),
		).toMatchObject({
			value: { range: { from: cell.at + 1, to: cell.at + cell.node.nodeSize - 1 } },
		})
		const neighbor = f.find('tableCell', 'Neighbor cell')
		const wholeTable = f.find('table')
		expect(
			captureTypstCandidateTarget({
				selection: CellSelection.create(f.editor.state.doc, cell.at, neighbor.at),
				regionId: 'body',
				baseRevision: 7,
				scope: 'blocks',
			}),
		).toMatchObject({
			value: { range: { from: wholeTable.at, to: wholeTable.at + wholeTable.node.nodeSize } },
		})
	})

	it('replaces cell and notice paragraphs while preserving every surrounding node and one undo', () => {
		for (const [text, path] of [
			['Cell detail', [1, 1, 0, 1]],
			['Notice intro', [2, 0]],
		] as const) {
			const f = nestedFixture()
			const before = f.editor.getJSON()
			const target = f.find('paragraph', text)
			const prepared = f.prepare({
				regionId: 'body',
				baseRevision: 7,
				format: 'agent',
				range: { from: target.at, to: target.at + target.node.nodeSize },
				markdown: '[textStyle {"color":"#f00"}]Updated **detail**[/textStyle]',
			})
			if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
			expect(f.dispatches).toBe(0)
			expect(prepared.value.document.content).toHaveLength(1)
			const expected = structuredClone(before)
			let parent: JSONContent = expected
			for (const index of path.slice(0, -1)) parent = parent.content![index]!
			parent.content![path.at(-1)!] = prepared.value.document.content![0]!
			const expectedNative = f.editor.schema.nodeFromJSON(expected).toJSON()
			expect(prepared.value.mergedDocument).toEqual(expectedNative)
			expect(applyTypstCandidate({ ...f.applyOptions, candidate: prepared.value })).toEqual({
				ok: true,
				value: undefined,
			})
			expect(f.editor.getJSON()).toEqual(expectedNative)
			expect(f.editor.getJSON()).toEqual(prepared.value.mergedDocument)
			expect(f.dispatches).toBe(1)
			expect(undo(f.editor.state, f.dispatch)).toBe(true)
			expect(f.editor.getJSON()).toEqual(before)
		}
	})

	it('keeps ordinary Markdown loss checks local to the selected child blocks', () => {
		const f = nestedFixture()
		for (const [text, lossless] of [
			['Cell detail', true],
			['Notice intro', false],
		] as const) {
			const target = f.find('paragraph', text)
			const prepared = f.prepare({
				regionId: 'body',
				baseRevision: 7,
				range: { from: target.at, to: target.at + target.node.nodeSize },
				markdown: 'Updated detail',
			})
			expect(prepared.ok).toBe(lossless)
			expect(prepared.ok ? [] : [...new Set(prepared.issues.map((issue) => issue.code))]).toEqual(
				lossless ? [] : ['COMPLEX_CONTENT'],
			)
		}
		expect(f.dispatches).toBe(0)
	})

	it('rejects cross-parent boundaries and table rows or cells as independent replacement fragments', () => {
		const f = nestedFixture()
		const target = f.find('paragraph', 'Cell detail')
		const neighbor = f.find('paragraph', 'Neighbor cell')
		const wholeTable = f.find('table')
		const row = f.find('tableRow', 'Cell introCell detailNeighbor cell')
		const valid = { from: target.at, to: target.at + target.node.nodeSize }
		const candidate: TypstMarkdownCandidate = {
			regionId: 'body',
			baseRevision: 7,
			format: 'agent',
			range: valid,
			markdown: 'Updated',
		}
		const prepared = f.prepare(candidate)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		const before = f.editor.getJSON()
		for (const range of [
			{ from: target.at, to: neighbor.at + neighbor.node.nodeSize },
			{ from: wholeTable.at + 1, to: wholeTable.at + wholeTable.node.nodeSize - 1 },
			{ from: row.at + 1, to: row.at + row.node.nodeSize - 1 },
			{ from: target.at + 1, to: target.at + target.node.nodeSize - 1 },
		]) {
			expect(f.prepare({ ...candidate, range })).toMatchObject({
				ok: false,
				issues: [{ code: 'INVALID_CANDIDATE_RANGE' }],
			})
			expect(
				applyTypstCandidate({ ...f.applyOptions, candidate: { ...prepared.value, range } }),
			).toMatchObject({
				ok: false,
				issues: [{ code: 'INVALID_CANDIDATE_RANGE' }],
			})
		}
		expect(f.dispatches).toBe(0)
		expect(f.editor.getJSON()).toEqual(before)
	})

	it('validates the actual parent content rule before preparing a nested replacement', () => {
		const f = nestedFixture()
		const target = f.find('paragraph', 'List intro')
		expect(
			f.prepare({
				regionId: 'body',
				baseRevision: 7,
				format: 'agent',
				range: { from: target.at, to: target.at + target.node.nodeSize },
				markdown: '## A heading cannot be the first child of a native listItem',
			}),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'INVALID_STRUCTURE' })]),
		})
		expect(f.dispatches).toBe(0)
	})
})
