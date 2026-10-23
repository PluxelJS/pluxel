import { describe, expect, it } from 'vitest'
import { getSchema, type Editor, type JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { history, undo } from '@tiptap/pm/history'
import {
	applyTypstCandidate,
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
	attrs: { typstTableStyle: 'three-line' },
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

	it('rejects empty, partial, nested, noninteger and out-of-bounds ranges at both boundaries', () => {
		const f = fixture()
		const prepared = prepareTypstCandidate(f.prepareOptions)
		if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
		for (const range of [
			{ from: 0, to: 0 },
			{ from: f.candidate.range!.from + 1, to: f.candidate.range!.to },
			{ from: 3, to: 12 },
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
