import type { Editor, JSONContent } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import type { Selection } from '@tiptap/pm/state'
import type { Schema } from '@tiptap/pm/model'
import { exportTypstMarkdown, parseTypstMarkdown } from './markdown.js'
import { editorSchema, validateTypstRegion } from './validation.js'
import type {
	TypstDraftRevision,
	TypstEditorConfig,
	TypstEditorResult,
	TypstMarkdownCandidate,
	TypstPreparedCandidate,
} from './types.js'

/** Capture region/revision and, optionally, complete blocks in their nearest common container.
 * A nonempty selection has an exclusive end. A boundary caret chooses the following
 * block (the last at EOF). Selections spanning cells cover their enclosing table.
 * This reads the native selection without changing it or the document. */
export function captureTypstCandidateTarget(options: {
	selection: Selection
	regionId: string
	baseRevision: TypstDraftRevision
	scope: 'region' | 'blocks'
}): TypstEditorResult<Omit<TypstMarkdownCandidate, 'markdown'>> {
	const target = { regionId: options.regionId, baseRevision: options.baseRevision }
	if (options.scope === 'region') return { ok: true, value: target }
	const { selection } = options
	const doc = selection.$from.doc
	// CellSelection can have several ranges; .from/.to alone describe only its first cell.
	const start = Math.min(...selection.ranges.map((range) => range.$from.pos))
	const end = Math.max(...selection.ranges.map((range) => range.$to.pos))
	const $start = doc.resolve(start)
	for (let depth = $start.sharedDepth(end); depth >= 0; depth--) {
		const parent = $start.node(depth)
		if (parent.inlineContent) continue
		const parentStart = $start.start(depth)
		let from = -1
		let to = -1
		parent.forEach((node, offset, index) => {
			const position = parentStart + offset
			const limit = position + node.nodeSize
			const includes = selection.empty
				? start >= position && (start < limit || index === parent.childCount - 1)
				: start < limit && end > position
			if (includes) {
				if (from === -1) from = position
				to = limit
			}
		})
		if (
			from !== -1 &&
			from < to &&
			doc.type.validContent(parent.content.cut(from - parentStart, to - parentStart))
		)
			return { ok: true, value: { ...target, range: { from, to } } }
	}
	return {
		ok: false,
		issues: [
			{
				code: 'INVALID_CANDIDATE_RANGE',
				regionId: options.regionId,
				message: 'Place the cursor in a block or select the blocks to replace.',
			},
		],
	}
}

function admission(options: {
	regionId: string
	baseRevision: TypstDraftRevision
	currentRevision: TypstDraftRevision
	canEdit: (regionId: string) => boolean
}): TypstEditorResult<void> {
	if (!options.canEdit(options.regionId))
		return {
			ok: false,
			issues: [
				{
					code: 'FORBIDDEN_REGION',
					regionId: options.regionId,
					message: 'This region is not editable by the current user.',
				},
			],
		}
	if (options.baseRevision !== options.currentRevision)
		return {
			ok: false,
			issues: [
				{
					code: 'STALE_CANDIDATE',
					regionId: options.regionId,
					message:
						'The draft changed after this candidate was generated. Keep both documents and regenerate or explicitly rebase.',
				},
			],
		}
	return { ok: true, value: undefined }
}

/** Validate the full region before selecting the blocks that Markdown may replace. */
function candidateTarget(options: {
	document: JSONContent
	regionId: string
	range: TypstMarkdownCandidate['range']
	config: TypstEditorConfig
	data?: unknown
}): TypstEditorResult<{
	document: JSONContent
	from: number
	to: number
	startIndex: number
	endIndex: number
	path: number[]
	schema: Schema
}> {
	const checked = validateTypstRegion(options)
	if (!checked.ok) return checked
	const schema = editorSchema(options.config)
	if (!schema.ok) return schema
	const native = schema.value.nodeFromJSON(checked.value)
	const range = options.range
	if (range === undefined)
		return {
			ok: true,
			value: {
				document: checked.value,
				from: 0,
				to: native.content.size,
				startIndex: 0,
				endIndex: native.childCount,
				path: [],
				schema: schema.value,
			},
		}
	if (
		!range ||
		typeof range !== 'object' ||
		Array.isArray(range) ||
		Object.keys(range).some((key) => key !== 'from' && key !== 'to') ||
		!Number.isSafeInteger(range.from) ||
		!Number.isSafeInteger(range.to) ||
		range.from < 0 ||
		range.to > native.content.size ||
		range.from >= range.to
	)
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_CANDIDATE_RANGE',
					regionId: options.regionId,
					path: ['range'],
					message:
						'Candidate range must contain complete, nonempty blocks in one parent at the base revision.',
				},
			],
		}
	const $from = native.resolve(range.from)
	const $to = native.resolve(range.to)
	if (
		!$from.sameParent($to) ||
		$from.parent.inlineContent ||
		!native.type.validContent($from.parent.content.cut($from.parentOffset, $to.parentOffset))
	)
		return {
			ok: false,
			issues: [
				{
					code: 'INVALID_CANDIDATE_RANGE',
					regionId: options.regionId,
					path: ['range'],
					message:
						'Candidate range must contain complete, nonempty blocks in one parent at the base revision.',
				},
			],
		}
	const startIndex = $from.index()
	const endIndex = $to.index()
	const path = Array.from({ length: $from.depth }, (_, depth) => $from.index(depth))
	let parent = checked.value
	for (const index of path) parent = parent.content![index]!
	return {
		ok: true,
		value: {
			document: { ...checked.value, content: parent.content!.slice(startIndex, endIndex) },
			from: range.from,
			to: range.to,
			startIndex,
			endIndex,
			path,
			schema: schema.value,
		},
	}
}

function replaceTarget(
	document: JSONContent,
	target: { startIndex: number; endIndex: number; path: number[] },
	replacement: JSONContent,
): JSONContent {
	const replace = (node: JSONContent, depth: number): JSONContent => {
		if (depth === target.path.length)
			return {
				...node,
				content: [
					...node.content!.slice(0, target.startIndex),
					...(replacement.content ?? []),
					...node.content!.slice(target.endIndex),
				],
			}
		const index = target.path[depth]!
		const content = [...node.content!]
		content[index] = replace(content[index]!, depth + 1)
		return { ...node, content }
	}
	return replace(document, 0)
}

/** Stage Markdown for an entire region or complete sibling blocks. No document mutation. */
export function prepareTypstCandidate(options: {
	candidate: TypstMarkdownCandidate
	currentRevision: TypstDraftRevision
	document: JSONContent
	config: TypstEditorConfig
	data?: unknown
	canEdit: (regionId: string) => boolean
}): TypstEditorResult<TypstPreparedCandidate> {
	const accepted = admission({
		...options.candidate,
		currentRevision: options.currentRevision,
		canEdit: options.canEdit,
	})
	if (!accepted.ok) return accepted
	const target = candidateTarget({
		...options,
		regionId: options.candidate.regionId,
		range: options.candidate.range,
	})
	if (!target.ok) return target
	if (options.candidate.format !== 'agent') {
		const existing = exportTypstMarkdown({
			format: options.candidate.format,
			document: target.value.document,
			regionId: options.candidate.regionId,
			config: options.config,
			data: options.data,
		})
		if (!existing.ok) return existing
		if (!existing.value.lossless)
			return {
				ok: false,
				issues: [
					{
						code: 'COMPLEX_CONTENT',
						regionId: options.candidate.regionId,
						message:
							'Markdown cannot replace target blocks containing content without a lossless Markdown mapping.',
					},
					...existing.value.issues,
				],
			}
	}
	const parsed = parseTypstMarkdown({
		format: options.candidate.format,
		markdown: options.candidate.markdown,
		regionId: options.candidate.regionId,
		config: options.config,
		data: options.data,
	})
	if (!parsed.ok) return parsed
	const merged = validateTypstRegion({
		...options,
		regionId: options.candidate.regionId,
		document: replaceTarget(options.document, target.value, parsed.value),
	})
	if (!merged.ok) return merged
	return {
		ok: true,
		value: {
			...options.candidate,
			...(options.candidate.range ? { range: { ...options.candidate.range } } : {}),
			document: parsed.value,
			mergedDocument: target.value.schema.nodeFromJSON(merged.value).toJSON(),
		},
	}
}

/** Recheck the host snapshot at commit, then apply one native undoable transaction. */
export function applyTypstCandidate(options: {
	candidate: TypstPreparedCandidate
	editor: Editor
	regionId: string
	currentRevision: () => TypstDraftRevision
	config: TypstEditorConfig
	data?: () => unknown
	canEdit: (regionId: string) => boolean
}): TypstEditorResult<void> {
	if (options.regionId !== options.candidate.regionId)
		return {
			ok: false,
			issues: [
				{
					code: 'FORBIDDEN_REGION',
					regionId: options.candidate.regionId,
					message: 'Candidate target is not the editor region.',
				},
			],
		}
	const accepted = admission({
		...options.candidate,
		currentRevision: options.currentRevision(),
		canEdit: options.canEdit,
	})
	if (!accepted.ok) return accepted
	const data = options.data?.()
	const previous = options.editor.state.doc
	const document = options.editor.getJSON()
	const target = candidateTarget({
		document,
		regionId: options.regionId,
		range: options.candidate.range,
		config: options.config,
		data,
	})
	if (!target.ok) return target
	if (options.candidate.format !== 'agent') {
		const current = exportTypstMarkdown({
			format: options.candidate.format,
			document: target.value.document,
			regionId: options.regionId,
			config: options.config,
			data,
		})
		if (!current.ok) return current
		if (!current.value.lossless)
			return {
				ok: false,
				issues: [
					{
						code: 'COMPLEX_CONTENT',
						regionId: options.regionId,
						message: 'The target now contains content that Markdown cannot replace losslessly.',
					},
					...current.value.issues,
				],
			}
	}
	const parsed = validateTypstRegion({
		document: options.candidate.document,
		regionId: options.regionId,
		config: options.config,
		data,
	})
	if (!parsed.ok) return parsed
	const merged = validateTypstRegion({
		document: replaceTarget(document, target.value, parsed.value),
		regionId: options.regionId,
		config: options.config,
		data,
	})
	if (!merged.ok) return merged
	const replacement = options.editor.schema.nodeFromJSON(parsed.value)
	replacement.check()
	const expected = options.editor.schema.nodeFromJSON(merged.value)
	expected.check()
	// Host callbacks may inspect mutable state. Capture it again at the actual commit.
	const commit = admission({
		...options.candidate,
		currentRevision: options.currentRevision(),
		canEdit: options.canEdit,
	})
	if (!commit.ok) return commit
	if (!options.editor.state.doc.eq(previous))
		return {
			ok: false,
			issues: [
				{
					code: 'STALE_CANDIDATE',
					regionId: options.regionId,
					message: 'The editor changed while checking this candidate. Prepare it again.',
				},
			],
		}
	const transaction = closeHistory(options.editor.state.tr)
		.replaceWith(target.value.from, target.value.to, replacement.content)
		.setMeta('addToHistory', true)
		.setMeta('typst-candidate', true)
	options.editor.view.dispatch(transaction)
	if (options.editor.state.doc.eq(previous) && !previous.eq(expected))
		return {
			ok: false,
			issues: [
				{
					code: 'REGION_RULE',
					regionId: options.regionId,
					message:
						'The editor rejected the candidate transaction. The host must resolve its current editing restrictions before applying it.',
				},
			],
		}
	return { ok: true, value: undefined }
}
