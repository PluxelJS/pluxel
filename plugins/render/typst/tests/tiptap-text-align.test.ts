import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Editor, getSchema, type JSONContent } from '@tiptap/core'
import { closeHistory, history, redo, undo } from '@tiptap/pm/history'
import { describe, expect, it } from 'vitest'
import {
	createTypstExtensions,
	applyTypstCandidate,
	exportTypstMarkdown,
	generateTypstRegions,
	prepareTypstCandidate,
	validateTypstRegion,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'
import { textAlignments, textAlignmentDeclarationError } from '../src/tiptap/text-align.js'
import { captureBlockTarget, prepareBlockAction } from '../src/tiptap/block-actions.js'
import { convertBlock } from '../src/tiptap/insert-commands.js'
import type { EditorUiContext } from '../src/tiptap/editor-ui.js'
import runTypst from '../src/worker.ts'
import { pointAtSource } from '../src/browser/navigation.js'

const config: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
const context: EditorUiContext = {
	config,
	region: config.regions[0],
	editable: true,
	composing: false,
	fontFamilies: [],
	slashCommands: [],
}
const block = (
	textAlign: unknown = null,
	type = 'paragraph',
	text = 'Aligned text',
): JSONContent => ({
	type,
	attrs: { ...(type === 'heading' ? { level: 2 } : {}), textAlign },
	content: [{ type: 'text', text }],
})
const document = (...content: JSONContent[]): JSONContent => ({ type: 'doc', content })
function createEditor(content: JSONContent) {
	const editor = new Editor({ element: null, extensions: createTypstExtensions(), content })
	editor.view.updateState(editor.state.reconfigure({ plugins: [history()] }))
	return editor
}

describe('native paragraph and heading alignment', () => {
	it('strictly accepts the four native values and null inheritance without rewriting authored JSON', () => {
		const schema = getSchema(createTypstExtensions())
		for (const type of ['paragraph', 'heading']) {
			for (const value of [...textAlignments, null]) {
				const authored = document(block(value, type))
				const checked = validateTypstRegion({ config, regionId: 'body', document: authored })
				expect(checked).toEqual({ ok: true, value: authored })
				if (!checked.ok) throw new Error(JSON.stringify(checked.issues))
				expect(checked.value).toBe(authored)
				expect(schema.nodeFromJSON(authored).toJSON()).toEqual(authored)
			}
			const omitted = block(null, type)
			delete omitted.attrs!.textAlign
			expect(
				validateTypstRegion({ config, regionId: 'body', document: document(omitted) }).ok,
			).toBe(true)
			for (const value of ['', 'start', 'end', 'inherit', 'CENTER', false, 0, {}, ['left']]) {
				expect(
					validateTypstRegion({ config, regionId: 'body', document: document(block(value, type)) }),
				).toMatchObject({
					ok: false,
					issues: expect.arrayContaining([
						expect.objectContaining({
							code: 'INVALID_ATTRIBUTE',
							path: ['content', 0, 'attrs', 'textAlign'],
						}),
					]),
				})
			}
		}
		expect(
			validateTypstRegion({
				config,
				regionId: 'body',
				document: document(block('center', 'codeBlock')),
			}),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_ATTRIBUTE' })]),
		})
	})

	it('uses native commands for a mixed selection, one undo/redo, reset and subsequent caret input', () => {
		const editor = createEditor(document(block(null), block('right', 'heading'), block('left')))
		try {
			const first = editor.state.doc.child(0).nodeSize
			const second = editor.state.doc.child(1).nodeSize
			editor.commands.setTextSelection({ from: 2, to: first + second - 1 })
			const before = editor.getJSON()
			const selection = editor.state.selection.toJSON()
			expect(editor.commands.setTextAlign('center')).toBe(true)
			expect(editor.state.selection.toJSON()).toEqual(selection)
			expect(editor.getJSON().content!.map((node) => node.attrs!.textAlign)).toEqual([
				'center',
				'center',
				'left',
			])
			const after = editor.getJSON()
			expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(undo(editor.state)).toBe(false)
			expect(redo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
			expect(editor.getJSON()).toEqual(after)
			editor.view.dispatch(closeHistory(editor.state.tr))
			expect(editor.commands.unsetTextAlign()).toBe(true)
			expect(editor.getJSON().content!.map((node) => node.attrs!.textAlign)).toEqual([
				null,
				null,
				'left',
			])
			editor.commands.setTextSelection(2)
			expect(editor.commands.setTextAlign('justify')).toBe(true)
			editor.view.dispatch(editor.state.tr.insertText('typed'))
			expect(editor.state.doc.child(0).attrs.textAlign).toBe('justify')
			const valid = editor.getJSON()
			expect(editor.commands.setTextAlign('inherit')).toBe(false)
			expect(editor.getJSON()).toEqual(valid)
		} finally {
			editor.destroy()
		}
	})

	it('retains per-block alignment across native block conversions and copies with one undo', () => {
		const editor = createEditor(document(block('center'), block('right')))
		try {
			editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 })
			const beforeProbe = editor.state
			expect(convertBlock(editor.can().chain(), 'heading-2').run()).toBe(true)
			expect(editor.state).toBe(beforeProbe)
			expect(undo(editor.state)).toBe(false)
			expect(convertBlock(editor.chain(), 'heading-2').run()).toBe(true)
			expect(editor.getJSON().content!.map((node) => [node.type, node.attrs!.textAlign])).toEqual([
				['heading', 'center'],
				['heading', 'right'],
			])
			for (const conversion of [
				'paragraph',
				'bulletList',
				'orderedList',
				'blockquote',
				'heading-3',
			] as const) {
				const target = captureBlockTarget(editor, 0)!
				const before = editor.getJSON()
				const tr = prepareBlockAction(editor, context, target, {
					type: 'convert',
					block: conversion,
				})!
				expect(tr).toBeDefined()
				editor.view.dispatch(tr)
				const values: unknown[] = []
				editor.state.doc.child(0).descendants((node) => {
					if (node.isTextblock) values.push(node.attrs.textAlign)
				})
				if (editor.state.doc.child(0).isTextblock)
					values.push(editor.state.doc.child(0).attrs.textAlign)
				expect(values).toEqual(['center'])
				const after = editor.getJSON()
				expect(undo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true)
				expect(editor.getJSON()).toEqual(before)
				expect(redo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true)
				expect(editor.getJSON()).toEqual(after)
			}
			const beforeCopy = editor.getJSON()
			editor.view.dispatch(
				prepareBlockAction(editor, context, captureBlockTarget(editor, 0)!, 'duplicate')!,
			)
			expect(editor.getJSON().content![1]).toEqual(beforeCopy.content![0])
			expect(undo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true)
			expect(editor.getJSON()).toEqual(beforeCopy)
		} finally {
			editor.destroy()
		}
	})

	it('retains each list paragraph alignment when lifting and converting a whole multi-item list', () => {
		const editor = createEditor(
			document({
				type: 'bulletList',
				content: [
					{ type: 'listItem', content: [block('center')] },
					{ type: 'listItem', content: [block('right')] },
				],
			}),
		)
		try {
			const before = editor.getJSON()
			const tr = prepareBlockAction(editor, context, captureBlockTarget(editor, 0)!, {
				type: 'convert',
				block: 'heading-2',
			})!
			expect(tr).toBeDefined()
			editor.view.dispatch(tr)
			expect(editor.getJSON().content!.map((node) => [node.type, node.attrs!.textAlign])).toEqual([
				['heading', 'center'],
				['heading', 'right'],
			])
			expect(undo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true)
			expect(editor.getJSON()).toEqual(before)
			expect(undo(editor.state)).toBe(false)
		} finally {
			editor.destroy()
		}
	})

	it('admits only lossless alignment CSS before browser normalization', () => {
		for (const alignment of textAlignments)
			expect(textAlignmentDeclarationError(`text-align: ${alignment};`)).toBeUndefined()
		for (const style of [
			'text-align: start',
			'text-align: inherit',
			'text-align: center !important',
			'text-align: center; text-align: right',
			'color: red',
			'width: 10px',
			'text-align: bogus',
			'text-align',
		])
			expect(textAlignmentDeclarationError(style)).toBeTypeOf('string')
	})

	it('reports Markdown loss at the attribute and protects aligned candidate targets without blocking unrelated plain targets', () => {
		for (const alignment of textAlignments) {
			const authored = document(block(alignment), block(null, 'paragraph', 'Replace me'))
			const exported = exportTypstMarkdown({ config, regionId: 'body', document: authored })
			expect(exported).toMatchObject({
				ok: true,
				value: {
					lossless: false,
					issues: expect.arrayContaining([
						expect.objectContaining({
							code: 'COMPLEX_CONTENT',
							path: ['content', 0, 'attrs', 'textAlign'],
						}),
					]),
				},
			})
			const options = { config, document: authored, currentRevision: 1, canEdit: () => true }
			expect(
				prepareTypstCandidate({
					...options,
					candidate: { regionId: 'body', baseRevision: 1, markdown: 'Replacement' },
				}),
			).toMatchObject({ ok: false })
			const native = getSchema(createTypstExtensions()).nodeFromJSON(authored)
			const prepared = prepareTypstCandidate({
				...options,
				candidate: {
					regionId: 'body',
					baseRevision: 1,
					markdown: 'Replacement',
					range: { from: native.child(0).nodeSize, to: native.content.size },
				},
			})
			expect(prepared.ok).toBe(true)
			if (!prepared.ok) throw new Error(JSON.stringify(prepared.issues))
			const editor = createEditor(authored)
			try {
				const before = editor.getJSON()
				expect(
					applyTypstCandidate({
						editor,
						config,
						regionId: 'body',
						candidate: prepared.value,
						currentRevision: () => 1,
						canEdit: () => true,
					}).ok,
				).toBe(true)
				expect(editor.getJSON().content![0]).toEqual(before.content![0])
				expect(editor.state.doc.child(1).textContent).toBe('Replacement')
				expect(undo(editor.state, (tr) => editor.view.dispatch(tr))).toBe(true)
				expect(editor.getJSON()).toEqual(before)
			} finally {
				editor.destroy()
			}
		}
		expect(
			exportTypstMarkdown({ config, regionId: 'body', document: document(block()) }),
		).toMatchObject({ ok: true, value: { lossless: true } })
	})

	it('compiles alignment into real PDF glyph positions while leaving template inheritance local', async () => {
		const root = await mkdtemp(join(tmpdir(), 'typst-alignment-'))
		try {
			const alignments = ['left', 'center', 'right', 'justify', null] as const
			const content = ['paragraph', 'heading'].flatMap((type) =>
				alignments.map((alignment) => block(alignment, type, 'Alignment')),
			)
			const longText =
				'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau. '.repeat(
					3,
				)
			content.push(block('left', 'paragraph', longText), block('justify', 'paragraph', longText))
			const generated = generateTypstRegions({
				config,
				regions: { body: document(...content) },
				data: {},
				snapshotRevision: 1,
			})
			if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
			for (const [path, source] of Object.entries({
				...generated.value.templateFiles,
				...generated.value.inputFiles,
			})) {
				const full = join(root, path.replace(/^\//, ''))
				await mkdir(dirname(full), { recursive: true })
				await writeFile(full, source)
			}
			await writeFile(
				join(root, 'main.typ'),
				'#set page(width: 400pt, height: 700pt, margin: 40pt)\n#set text(overhang: false)\n#set align(right)\n#set par(justify: true)\n#include "_editor/regions/body.typ"',
			)
			const compiled = runTypst({
				revision: 1,
				root,
				entry: 'main.typ',
				maxOutputBytes: 8_000_000,
				bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
			})
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
			expect(Buffer.from(compiled.pdf).subarray(0, 5).toString()).toBe('%PDF-')
			expect(compiled.navigation.outline).toHaveLength(5)
			const schema = getSchema(createTypstExtensions())
			let position = 1
			const xValues = content.slice(0, 10).map((node) => {
				const mapping = generated.value.mapping.find(
					(entry) => entry.kind === 'text' && entry.from === position,
				)!
				const point = pointAtSource(
					compiled.navigation.points,
					{ path: mapping.path, ...mapping.range.start },
					1,
				)
				expect(point).toBeDefined()
				position += schema.nodeFromJSON(node).nodeSize
				return point!.x
			})
			for (let offset = 0; offset <= 5; offset += 5) {
				const [left, center, right, justify, inherited] = xValues.slice(offset, offset + 5)
				expect(left).toBeCloseTo(40, 1)
				expect(center).toBeGreaterThan(left + 100)
				expect(right).toBeGreaterThan(center + 100)
				expect(justify).toBeCloseTo(left, 1)
				expect(inherited).toBeCloseTo(right, 1)
			}
			const lineEnds = content.slice(10).map((node) => {
				const points = generated.value.mapping
					.filter(
						(entry) =>
							entry.kind === 'text' &&
							entry.from >= position &&
							entry.from < position + longText.length &&
							/\S/.test(longText[entry.from - position]!),
					)
					.map((entry) =>
						pointAtSource(
							compiled.navigation.points,
							{ path: entry.path, ...entry.range.start },
							1,
						),
					)
					.filter((point) => point !== undefined)
				position += schema.nodeFromJSON(node).nodeSize
				const y = Math.min(...points.map((point) => point.y))
				expect(points.some((point) => point.y > y + 10)).toBe(true)
				return Math.max(
					...points
						.filter((point) => Math.abs(point.y - y) < 0.1)
						.map((point) => point.x + point.width),
				)
			})
			expect(lineEnds[1]).toBeCloseTo(360, 1)
			expect(lineEnds[0]).toBeLessThan(lineEnds[1] - 1)
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
})
