import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { JSONContent } from '@tiptap/core'
import type { TypstNavigation } from '../preview-contract.js'
import { findTypstEditorPosition } from '../source/positions.js'
import type { TypstSourceProject } from '../source/state-types.js'
import type { TypstSourceProjection } from '../source/types.js'
import type {
	TypstDocumentIssue,
	TypstDocumentNavigation,
	TypstDocumentReference,
	TypstDocumentResult,
	TypstDocumentSnapshot,
} from './types.js'

export type * from './types.js'

export interface TypstDocumentDefinition {
	readonly id: string
	readonly title: string
	/** Private, project-relative file containing the exposed body. */
	readonly path: string
	/** Optional native label of a template-owned heading before this body. */
	readonly label?: string
}

export interface TypstDocumentProjectOptions {
	/** Borrowed authority. Files, permissions and history remain owned by this source project. */
	readonly project: TypstSourceProject
	/** Read again after host transactions, such as adding or reordering chapters. */
	readonly documents:
		| readonly TypstDocumentDefinition[]
		| (() => readonly TypstDocumentDefinition[])
	/** Explicit public representations of project resources. Unregistered local resources fail closed. */
	readonly resources?: readonly { readonly path: string; readonly url: string }[]
	/** Additional template-owned targets, which need not have an editor destination. */
	readonly references?: readonly {
		readonly label: string
		readonly title: string
		readonly kind: TypstDocumentReference['kind']
	}[]
}

export interface TypstDocumentProject {
	view(): TypstDocumentSnapshot
	/** All failures contain only safe codes and messages, never source diagnostics. */
	edit(input: {
		readonly baseRevision: number
		readonly id: string
		readonly document: JSONContent
	}): TypstDocumentResult<TypstDocumentSnapshot>
	/** The host must supply navigation from a compilation of exactly this source revision. */
	navigation(input: {
		readonly revision: number
		readonly navigation: TypstNavigation
	}): TypstDocumentResult<TypstDocumentNavigation>
}

type Range = {
	source: number
	sourceEnd: number
	position: number
	endPosition: number
}
type Body = {
	definition: TypstDocumentDefinition
	projection: TypstSourceProjection
	document: JSONContent
	prefix: JSONContent[]
	opaque: Map<string, { original: JSONContent; placeholder: JSONContent }>
	identities: Map<string, { id?: string; label?: string | null }>
	virtualParagraph: boolean
	ranges: Range[]
	resources: Map<string, string[]>
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const objectTypes = new Set(['heading', 'figure', 'blockMath'])
const containers = new Set([
	'doc',
	'paragraph',
	'heading',
	'blockquote',
	'bulletList',
	'orderedList',
	'listItem',
	'codeBlock',
	'table',
	'tableRow',
	'tableCell',
	'tableHeader',
	'figure',
	'figureCaption',
])
const record = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === 'object' && !Array.isArray(value))
const localPath = (path: string) =>
	Boolean(
		path &&
		!path.includes('\\') &&
		!path.includes('\0') &&
		path.split('/').every((part) => part && part !== '.' && part !== '..'),
	)
const publicUrl = (url: string) =>
	/^(?:https?:\/\/|mailto:|tel:)/i.test(url) || /^\/(?!\/)/.test(url)
const externalUrl = (url: string) => /^(?:https?:\/\/|mailto:|tel:)/i.test(url)
function size(node: JSONContent): number {
	return node.type === 'text'
		? node.text!.length
		: containers.has(node.type!)
			? (node.type === 'doc' ? 0 : 2) +
				(node.content ?? []).reduce((sum, child) => sum + size(child), 0)
			: 1
}
function visit(node: JSONContent, action: (node: JSONContent) => void) {
	action(node)
	for (const child of node.content ?? []) visit(child, action)
}
function failure<T>(code: TypstDocumentIssue['code']): TypstDocumentResult<T> {
	const messages: Record<TypstDocumentIssue['code'], string> = {
		CONFLICT: 'The document changed. Reload before editing.',
		NOT_FOUND: 'The document is unavailable.',
		READ_ONLY: 'This document is read-only.',
		INVALID_EDIT: 'The edit was rejected. The document is unchanged.',
	}
	return { ok: false, issues: [{ code, message: messages[code] }] }
}
function invalid(): never {
	throw new InvalidEdit()
}
class InvalidEdit extends Error {}

/** Source-free projection and admission over the existing source project; no second body or history. */
export function createTypstDocumentProject(
	options: TypstDocumentProjectOptions,
): TypstDocumentProject {
	const { project } = options
	const secret = randomBytes(32)
	const labelIds = new Map<string, string>()
	const labels = new Map<string, string>()
	const objectIds = new Map<string, string>()
	const resources = new Map<string, string>()
	const resourcePaths = new Map<string, string>()
	for (const { path, url } of options.resources ?? []) {
		if (!localPath(path) || !publicUrl(url) || resources.has(path) || resourcePaths.has(url))
			throw new TypeError('Document resources require unique project paths and public URLs.')
		resources.set(path, url)
		resourcePaths.set(url, path)
	}
	const publicId = (label: string): string => {
		let id = labelIds.get(label)
		if (!id) {
			id = randomUUID()
			labelIds.set(label, id)
			labels.set(id, label)
		}
		return id
	}
	const resourceUrl = (path: string, source: string): string => {
		const resolved = posix.normalize(
			source.startsWith('/') ? source.slice(1) : posix.join(posix.dirname(path), source),
		)
		const url = resources.get(resolved)
		if (!url) throw new TypeError('An exposed document uses an unregistered local resource.')
		return url
	}
	const definitions = (): readonly TypstDocumentDefinition[] => {
		const values = typeof options.documents === 'function' ? options.documents() : options.documents
		if (
			values.some(
				(value) => !value.id || !localPath(value.path) || typeof value.title !== 'string',
			) ||
			new Set(values.map((value) => value.id)).size !== values.length ||
			new Set(values.map((value) => value.path)).size !== values.length
		)
			throw new TypeError('Exposed documents require unique IDs and project paths.')
		return values
	}
	const body = (definition: TypstDocumentDefinition): Body => {
		const projection = project.open(definition.path)
		const content = [...(projection.document.content ?? [])]
		const prefix: JSONContent[] = []
		while (
			content[0]?.type === 'typstImport' ||
			(content[0]?.type === 'typstSource' && content[0].attrs?.role === 'environment')
		)
			prefix.push(content.shift()!)
		const opaque: Body['opaque'] = new Map()
		const identities: Body['identities'] = new Map()
		const occurrences = new Map<string, number>()
		const ranges: Range[] = []
		const authoredResources = new Map<string, string[]>()
		const exposeResource = (source: string) => {
			const url = resourceUrl(definition.path, source)
			const paths = authoredResources.get(url) ?? []
			paths.push(source)
			authoredResources.set(url, paths)
			return url
		}
		const convert = (node: JSONContent, source: number, position: number): JSONContent => {
			let result: JSONContent
			if (node.type?.startsWith('typst')) {
				const identity = JSON.stringify(node)
				const occurrence = occurrences.get(identity) ?? 0
				occurrences.set(identity, occurrence + 1)
				const key = createHmac('sha256', secret)
					.update(`${definition.id}:${identity}:${occurrence}`)
					.digest('hex')
				result = {
					type:
						node.type === 'typstInlineSource' || node.type === 'typstField'
							? 'documentInline'
							: 'documentBlock',
					attrs: { key, title: '固定内容' },
				}
				opaque.set(key, { original: node, placeholder: result })
			} else {
				result = structuredClone(node)
				if (objectTypes.has(node.type!)) {
					const label = node.attrs?.label as string | null | undefined
					let id = label ? publicId(label) : undefined
					if (!id && node.type !== 'heading') {
						const key = `${definition.path}:${node.attrs?.id}`
						id = objectIds.get(key) ?? randomUUID()
						objectIds.set(key, id)
					}
					result.attrs = { ...result.attrs, id: id ?? null }
					delete result.attrs.label
					if (id) identities.set(id, { id: node.attrs?.id, label })
				}
				if (node.type === 'reference') result.attrs!.target = publicId(node.attrs!.target)
				if (node.type === 'image') result.attrs!.src = exposeResource(node.attrs!.src)
				for (const mark of result.marks ?? []) {
					if (
						mark.type === 'link' &&
						typeof mark.attrs?.href === 'string' &&
						!externalUrl(mark.attrs.href)
					)
						mark.attrs.href = exposeResource(mark.attrs.href)
				}
				if (node.content) {
					let sourceAt = source + (node.type === 'doc' ? 0 : 1)
					let at = position + (node.type === 'doc' ? 0 : 1)
					result.content = node.content.map((child) => {
						const next = convert(child, sourceAt, at)
						sourceAt += size(child)
						at += size(next)
						return next
					})
				}
			}
			ranges.push({
				source,
				sourceEnd: source + size(node),
				position,
				endPosition: position + size(result),
			})
			return result
		}
		let source = prefix.reduce((sum, node) => sum + size(node), 0)
		let position = 0
		const virtualParagraph = content.length === 0
		const document: JSONContent = {
			type: 'doc',
			content: content.map((node) => {
				const next = convert(node, source, position)
				source += size(node)
				position += size(next)
				return next
			}),
		}
		if (virtualParagraph) document.content = [{ type: 'paragraph' }]
		return {
			definition,
			projection,
			document,
			prefix,
			opaque,
			identities,
			virtualParagraph,
			ranges,
			resources: authoredResources,
		}
	}
	const positionAt = (value: Body, position: number): number | undefined => {
		const range = value.ranges
			.filter((item) => position >= item.source && position <= item.sourceEnd)
			.sort((a, b) => a.sourceEnd - a.source - (b.sourceEnd - b.source))[0]
		return (
			range &&
			range.position + Math.min(position - range.source, range.endPosition - range.position)
		)
	}
	const snapshot = (bodies: readonly Body[]): TypstDocumentSnapshot => {
		const references = new Map<string, TypstDocumentReference>()
		for (const value of options.references ?? []) {
			const id = publicId(value.label)
			references.set(id, { id, title: value.title, kind: value.kind })
		}
		for (const value of bodies) {
			for (const label of value.projection.labels) {
				if (!label.target) continue
				const position = positionAt(value, label.target.position)
				if (position === undefined) continue
				const id = publicId(label.label)
				references.set(id, {
					id,
					title:
						label.target.title ||
						{
							heading: '未命名章节',
							figure: '未命名图片',
							table: '未命名表格',
							equation: '独立公式',
						}[label.target.kind],
					kind: label.target.kind,
					location: { documentId: value.definition.id, position },
				})
			}
			if (value.definition.label) {
				const id = publicId(value.definition.label)
				references.set(id, {
					id,
					title: value.definition.title,
					kind: 'heading',
					location: { documentId: value.definition.id, position: 0 },
				})
			}
		}
		return {
			revision: project.revision,
			canUndo: project.canUndo,
			canRedo: project.canRedo,
			documents: bodies.map((value) => ({
				id: value.definition.id,
				title: value.definition.title,
				editable: project.isWritable(value.definition.path),
				document: value.document,
			})),
			references: [...references.values()],
		}
	}
	return {
		view() {
			return snapshot(definitions().map(body))
		},
		edit(input) {
			if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision !== project.revision)
				return failure('CONFLICT')
			const definition = definitions().find((value) => value.id === input.id)
			if (!definition) return failure('NOT_FOUND')
			if (!project.isWritable(definition.path)) return failure('READ_ONLY')
			const current = body(definition)
			const pending = new Map<string, string>()
			const used = new Set<string>()
			const keys: string[] = []
			const resourceOccurrences = new Map<string, number>()
			try {
				// Allocate new identities before restoring references, including forward references.
				const collect = (value: unknown) => {
					if (!record(value) || typeof value.type !== 'string') invalid()
					const attrs = value.attrs
					if (objectTypes.has(value.type) && record(attrs) && attrs.id != null) {
						if (typeof attrs.id !== 'string' || used.has(attrs.id)) invalid()
						used.add(attrs.id)
						if (!current.identities.has(attrs.id)) {
							if (!uuid.test(attrs.id) || labels.has(attrs.id)) invalid()
							pending.set(attrs.id, `document-${randomUUID()}`)
						}
					}
					if (value.content !== undefined) {
						if (!Array.isArray(value.content)) invalid()
						value.content.forEach(collect)
					}
				}
				collect(input.document)
				const restore = (value: unknown): JSONContent => {
					if (!record(value) || typeof value.type !== 'string' || value.type.startsWith('typst'))
						invalid()
					if (
						Object.keys(value).some(
							(key) => !['type', 'attrs', 'marks', 'content', 'text'].includes(key),
						)
					)
						invalid()
					if (value.type === 'documentBlock' || value.type === 'documentInline') {
						const key = record(value.attrs) ? value.attrs.key : undefined
						const original = typeof key === 'string' ? current.opaque.get(key) : undefined
						if (
							!original ||
							value.type !== original.placeholder.type ||
							!record(value.attrs) ||
							value.attrs.title !== '固定内容' ||
							Object.keys(value.attrs).some((name) => !['key', 'title'].includes(name)) ||
							Object.keys(value).some((name) => !['type', 'attrs'].includes(name))
						)
							invalid()
						keys.push(key as string)
						return structuredClone(original.original)
					}
					const node = structuredClone(value) as JSONContent
					if (node.attrs !== undefined && !record(node.attrs)) invalid()
					if (
						Object.keys(node.attrs ?? {}).some((key) =>
							['source', 'module', 'file', 'path', 'label'].includes(key),
						)
					)
						invalid()
					if (objectTypes.has(node.type!)) {
						const id = node.attrs?.id as string | null | undefined
						const original = id ? current.identities.get(id) : undefined
						const label = id ? (pending.get(id) ?? original?.label) : null
						node.attrs = { ...node.attrs, label: label ?? null }
						if (node.type === 'heading') delete node.attrs.id
						else node.attrs.id = original?.id ?? label
					}
					if (node.type === 'reference') {
						const label = pending.get(node.attrs?.target) ?? labels.get(node.attrs?.target)
						if (!label) invalid()
						node.attrs!.target = label
					}
					const restoreUrl = (url: unknown): string => {
						if (typeof url !== 'string') invalid()
						const path = resourcePaths.get(url)
						if (!path) invalid()
						const occurrence = resourceOccurrences.get(url) ?? 0
						resourceOccurrences.set(url, occurrence + 1)
						return (
							current.resources.get(url)?.[occurrence] ??
							posix.relative(posix.dirname(definition.path), path)
						)
					}
					if (node.type === 'image') {
						if (!node.attrs) invalid()
						node.attrs.src = restoreUrl(node.attrs.src)
					}
					if (node.marks !== undefined && !Array.isArray(node.marks)) invalid()
					for (const mark of node.marks ?? []) {
						if (
							!record(mark) ||
							typeof mark.type !== 'string' ||
							Object.keys(mark).some((key) => !['type', 'attrs'].includes(key))
						)
							invalid()
						if (mark.type === 'link') {
							if (!record(mark.attrs) || typeof mark.attrs.href !== 'string') invalid()
							if (!externalUrl(mark.attrs.href)) mark.attrs.href = restoreUrl(mark.attrs.href)
						}
					}
					if (node.content) node.content = node.content.map(restore)
					return node
				}
				const restored = restore(input.document)
				if (
					restored.type !== 'doc' ||
					JSON.stringify(keys) !== JSON.stringify([...current.opaque.keys()])
				)
					invalid()
				// An empty source needs a writable caret, not an authored empty block.
				const first = restored.content?.[0]
				if (
					current.virtualParagraph &&
					restored.content?.length === 1 &&
					first?.type === 'paragraph' &&
					!first.content?.length &&
					!first.marks?.length &&
					Object.entries(first.attrs ?? {}).every(
						([key, value]) => key === 'textAlign' && value == null,
					)
				)
					restored.content = []
				restored.content = [...current.prefix, ...(restored.content ?? [])]
				const result = project.edit({ projection: current.projection, document: restored })
				if (!result.ok)
					return failure(
						result.issues.some((issue) => issue.code === 'CONFLICT') ? 'CONFLICT' : 'INVALID_EDIT',
					)
				for (const [id, label] of pending) {
					labels.set(id, label)
					labelIds.set(label, id)
				}
				// Unlabelled objects retain their issued IDs through reparsing after an accepted edit.
				const before: JSONContent[] = [],
					after: JSONContent[] = []
				visit(input.document, (node) => {
					if (['figure', 'blockMath'].includes(node.type!)) before.push(node)
				})
				visit(project.open(definition.path).document, (node) => {
					if (['figure', 'blockMath'].includes(node.type!)) after.push(node)
				})
				for (let index = 0; index < after.length; index++)
					if (!after[index]!.attrs?.label && before[index]?.attrs?.id)
						objectIds.set(`${definition.path}:${after[index]!.attrs?.id}`, before[index]!.attrs!.id)
				return { ok: true, value: snapshot(definitions().map(body)) }
			} catch (error) {
				if (!(error instanceof InvalidEdit)) throw error
				return failure('INVALID_EDIT')
			}
		},
		navigation(input) {
			if (input.revision !== project.revision) return failure('CONFLICT')
			const bodies = definitions().map(body)
			const view = snapshot(bodies)
			const byPath = new Map(bodies.map((value) => [value.definition.path, value]))
			const points: TypstDocumentNavigation['points'][number][] = []
			for (const point of input.navigation.points) {
				const value = byPath.get(point.path.replace(/^\//, ''))
				if (!value) continue
				const from = findTypstEditorPosition({
					projection: value.projection,
					sourcePosition: point,
				})
				if (from === undefined) continue
				const position = positionAt(value, from)
				if (position === undefined) continue
				const end = findTypstEditorPosition({
					projection: value.projection,
					sourcePosition: { path: point.path, line: point.endLine, column: point.endColumn },
				})
				points.push({
					documentId: value.definition.id,
					position,
					endPosition: Math.max(
						position + 1,
						end === undefined ? position + 1 : (positionAt(value, end) ?? position + 1),
					),
					page: point.page,
					x: point.x,
					y: point.y,
					width: point.width,
					height: point.height,
				})
			}
			const references = new Map(view.references.map((value) => [value.id, value]))
			const targets: TypstDocumentNavigation['targets'][number][] =
				input.navigation.targets.flatMap((target) => {
					const id = labelIds.get(target.label)
					const reference = id ? references.get(id) : undefined
					return reference
						? [
								{
									id: reference.id,
									page: target.page,
									x: target.x,
									y: target.y,
									...(reference.location ? { location: reference.location } : {}),
								},
							]
						: []
				})
			// Frame URLs retain their authored spelling. Only an unambiguous registered
			// resource may cross the boundary; identical relative strings in different
			// documents must not select one document's resource for another.
			const resourceLinks = new Map<string, Set<string>>()
			const registerLink = (authored: string, url: string) => {
				const urls = resourceLinks.get(authored) ?? new Set<string>()
				urls.add(url)
				resourceLinks.set(authored, urls)
			}
			for (const [path, url] of resources) {
				registerLink(path, url)
				registerLink(`/${path}`, url)
				registerLink(url, url)
			}
			for (const value of bodies)
				for (const [url, paths] of value.resources)
					for (const path of paths) registerLink(path, url)
			const links: TypstDocumentNavigation['links'][number][] = input.navigation.links.flatMap<
				TypstDocumentNavigation['links'][number]
			>((link) => {
				const box = {
					page: link.page,
					x: link.x,
					y: link.y,
					width: link.width,
					height: link.height,
				}
				if (link.target.kind === 'url') {
					const registered = resourceLinks.get(link.target.url)
					const url = externalUrl(link.target.url)
						? link.target.url
						: registered?.size === 1
							? [...registered][0]
							: undefined
					return url ? [{ ...box, title: url, target: { kind: 'url' as const, url } }] : []
				}
				const destination = link.target
				const target = targets.find(
					(value) =>
						value.page === destination.page &&
						value.x === destination.x &&
						value.y === destination.y,
				)
				const reference = target ? references.get(target.id) : undefined
				return [
					{
						...box,
						title: reference?.title ?? '文档位置',
						target: {
							kind: 'position' as const,
							page: destination.page,
							x: destination.x,
							y: destination.y,
							...(target?.location ? { location: target.location } : {}),
						},
					},
				]
			})
			return {
				ok: true,
				value: {
					revision: input.revision,
					pages: input.navigation.pages.map(({ page, width, height }) => ({ page, width, height })),
					points,
					targets,
					links,
				},
			}
		},
	}
}
