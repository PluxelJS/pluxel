import type { AstExpr, AstFuncCall, AstContentBlock, AstArg } from '@r4ai/typst-ast-node'
import type { JSONContent } from '@tiptap/core'
import { typstSourceLibrary } from './library.js'
import { parseTypstSource, sourceSlice } from './parse.js'
import type {
	TypstSourceProjectionInput,
	TypstParsedProjection,
	TypstSourceNodeOrigin,
	TypstSourceRange,
	TypstSourceMapping,
	TypstSourceLabel,
	TypstSourceReference,
} from './types.js'

type Mark = NonNullable<JSONContent['marks']>[number]
type Built = { node: JSONContent; origin: TypstSourceNodeOrigin }
const environment = new Set(['letBinding', 'moduleImport', 'moduleInclude', 'setRule', 'showRule'])
const controls = new Set(['forLoop', 'whileLoop', 'conditional', 'codeBlock', 'contextual'])
const named = (call: AstFuncCall, name: string) =>
	call.args.find((arg) => arg.kind === 'named' && arg.name === name)?.expr
const positional = (call: AstFuncCall) =>
	call.args
		.filter((arg): arg is AstArg & { kind: 'pos' } => arg.kind === 'pos')
		.map((arg) => arg.expr)
const callName = (call: AstFuncCall): string | undefined =>
	call.callee.kind === 'ident'
		? call.callee.name
		: call.callee.kind === 'fieldAccess' && call.callee.target.kind === 'ident'
			? `${call.callee.target.name}.${call.callee.field}`
			: undefined
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const plainText = (node: JSONContent): string =>
	node.text ?? node.content?.map(plainText).join('') ?? ''

/** One source file is one rebuildable editor projection; include/import remain ordinary source. */
export function projectTypstSource(input: TypstSourceProjectionInput): TypstParsedProjection {
	const parsed = parseTypstSource(input.source, input.parser)
	const slice = (range: TypstSourceRange) => sourceSlice(parsed, range.from, range.to)
	const byteLength = parsed.cst.range[1]
	const hashStarts = new Set<number>()
	const comments: TypstSourceRange[] = []
	const cstNodes = new Map<string, typeof parsed.cst>()
	const cstVisit = (node: typeof parsed.cst) => {
		cstNodes.set(`${node.kind}:${node.range[0]}:${node.range[1]}`, node)
		if (node.kind === 'Hash') hashStarts.add(node.range[1])
		if (node.kind === 'LineComment' || node.kind === 'BlockComment')
			comments.push({ from: node.range[0], to: node.range[1] })
		node.children.forEach(cstVisit)
	}
	cstVisit(parsed.cst)
	const invalidRanges: TypstSourceRange[] = []
	const hasError = (node: typeof parsed.cst): boolean =>
		node.kind === 'Error' || node.children.some(hasError)
	for (const node of parsed.cst.children)
		if (hasError(node)) {
			const range = {
				from: hashStarts.has(node.range[0]) ? node.range[0] - 1 : node.range[0],
				to: node.range[1],
			}
			const previous = invalidRanges.at(-1)
			if (previous && previous.to >= range.from) previous.to = Math.max(previous.to, range.to)
			else invalidRanges.push(range)
		}
	const invalidExpressions = new Set<AstExpr>()
	const rootExpressions = parsed.ast.filter(
		(expr) =>
			!expr.range ||
			!invalidRanges.some((range) => expr.range![0] < range.to && expr.range![1] > range.from),
	)
	for (const range of invalidRanges) {
		const expr: AstExpr = { kind: 'codeBlock', range: [range.from, range.to], body: [] }
		invalidExpressions.add(expr)
		rootExpressions.push(expr)
	}
	rootExpressions.sort((a, b) => (a.range?.[0] ?? 0) - (b.range?.[0] ?? 0))
	const rangeOf = (expr: AstExpr, includeHash = true): TypstSourceRange => {
		const range = expr.range ?? [0, 0]
		return { from: includeHash && hashStarts.has(range[0]) ? range[0] - 1 : range[0], to: range[1] }
	}
	const hasComments = (range: TypstSourceRange) =>
		comments.some((c) => c.from >= range.from && c.to <= range.to)
	const make = (
		node: JSONContent,
		range: TypstSourceRange,
		children: Built[] = [],
		extra: Partial<TypstSourceNodeOrigin> = {},
	): Built => {
		if (children.length > 0) node.content = children.map((child) => child.node)
		return {
			node,
			origin: {
				...range,
				nodePath: [],
				preserve: hasComments(range),
				original: node,
				children: children.map((child) => child.origin),
				...extra,
			},
		}
	}
	const callInsertion = (expr: AstFuncCall) => {
		const args = cstNodes
			.get(`FuncCall:${expr.range![0]}:${expr.range![1]}`)
			?.children.find((node) => node.kind === 'Args')
		const right = args?.children.find((node) => node.kind === 'RightParen'),
			left = args?.children.find((node) => node.kind === 'LeftParen')
		return right && left
			? {
					insertAt: right.range[0],
					insertPrefix: sourceSlice(parsed, left.range[1], right.range[0]).trim() ? ', ' : '',
					insertSuffix: '',
				}
			: { insertAt: expr.callee.range![1], insertPrefix: '(', insertSuffix: ')' }
	}
	const callParameters = (expr: AstFuncCall) => {
		const args =
			cstNodes
				.get(`FuncCall:${expr.range![0]}:${expr.range![1]}`)
				?.children.find((node) => node.kind === 'Args')?.children ?? []
		const parameters: Record<string, TypstSourceRange> = {},
			removableParameters: Record<string, TypstSourceRange> = {}
		for (const arg of expr.args)
			if (arg.kind === 'named' && arg.expr.range) parameters[arg.name] = rangeOf(arg.expr, false)
		for (let index = 0; index < args.length; index++) {
			const arg = args[index]!
			if (arg.kind !== 'Named') continue
			const name = arg.children[0]?.text,
				next = args.slice(index + 1).find((node) => node.kind !== 'Space'),
				previous = args
					.slice(0, index)
					.toReversed()
					.find((node) => node.kind !== 'Space')
			if (
				!name ||
				[next?.kind, previous?.kind].some(
					(kind) => kind === 'LineComment' || kind === 'BlockComment',
				)
			)
				continue
			removableParameters[name] = {
				from:
					previous?.kind === 'Comma' && next?.kind !== 'Comma' ? previous.range[0] : arg.range[0],
				to: next?.kind === 'Comma' ? next.range[1] : arg.range[1],
			}
		}
		return { parameters, removableParameters }
	}
	const sourceNode = (expr: AstExpr, inline: boolean, role = 'unknown'): Built => {
		const range = rangeOf(expr)
		return make(
			{ type: inline ? 'typstInlineSource' : 'typstSource', attrs: { source: slice(range), role } },
			range,
			[],
			{ preserve: true, fixed: role === 'environment' },
		)
	}
	const labels: TypstSourceLabel[] = []
	const references: TypstSourceReference[] = []
	// Only syntax references are indexed. Strings, comments, and computed labels are not searched.
	const collect = (value: unknown, dynamic = false, markup = false) => {
		if (!value || typeof value !== 'object') return
		if (Array.isArray(value)) {
			value.forEach((child) => collect(child, dynamic, markup))
			return
		}
		const expr = value as AstExpr
		if (
			expr.range &&
			invalidRanges.some((range) => expr.range![0] < range.to && expr.range![1] > range.from)
		)
			return
		const nestedDynamic = dynamic || controls.has(expr.kind) || expr.kind === 'closure'
		if (expr.kind === 'label' && expr.range && !dynamic && markup)
			labels.push({ ...rangeOf(expr, false), path: input.path, label: expr.name })
		if (expr.kind === 'ref' && expr.range && !dynamic) {
			const from = expr.range[0]
			const length = new TextEncoder().encode(`@${expr.target}`).length
			references.push({ from, to: from + length, path: input.path, label: expr.target })
		}
		for (const [key, child] of Object.entries(value))
			if (child && typeof child === 'object')
				collect(
					child,
					nestedDynamic,
					key === 'body' &&
						['contentBlock', 'strong', 'emph', 'heading', 'listItem', 'enumItem'].includes(
							expr.kind,
						),
				)
	}
	collect(parsed.ast, false, true)
	const resolvePath = (path: string): string | undefined => {
		if (path.startsWith('/') || path.includes('\\')) return undefined
		const parts = input.path.split('/').slice(0, -1)
		for (const part of path.split('/')) {
			if (!part || part === '.') continue
			if (part === '..') {
				if (parts.length === 0) return undefined
				parts.pop()
			} else parts.push(part)
		}
		return parts.join('/')
	}
	const imported = (
		name: string,
		scope: Set<string>,
	): { module: string; name?: string } | undefined => {
		for (const value of scope) {
			const fields = value.split('\0')
			if (fields[0] === '$import' && fields[1] === name)
				return { module: fields[2]!, name: fields[3] || undefined }
		}
		return undefined
	}
	const clearImport = (name: string, scope: Set<string>) => {
		for (const value of scope) if (value.startsWith(`$import\0${name}\0`)) scope.delete(value)
	}
	const bind = (scope: Set<string>, local: string, module: string, name = '') => {
		clearImport(local, scope)
		scope.add(`$import\0${local}\0${module}\0${name}`)
	}
	const isLibrary = (path: string) => {
		const value = input.files?.[path]
		if (typeof value === 'string') return value === typstSourceLibrary
		if (value instanceof Uint8Array) {
			try {
				return new TextDecoder('utf-8', { fatal: true }).decode(value) === typstSourceLibrary
			} catch {
				return false
			}
		}
		return false
	}
	const helper = (
		call: AstFuncCall,
		scope: Set<string>,
	): { name: string; module: string; callee: string; library: boolean } | undefined => {
		const callee = callName(call)
		if (!callee) return undefined
		const [local, field] = callee.split('.')
		const binding = imported(local!, scope)
		const name = field ?? binding?.name
		if (!binding || !name) return undefined
		return { name, module: binding.module, callee, library: isLibrary(binding.module) }
	}
	const shadowNames = (expr: AstExpr, scope: Set<string>) => {
		if (expr.kind === 'letBinding') {
			const binding = expr.bindingKind
			if (binding?.kind === 'closure') {
				scope.add(binding.name)
				clearImport(binding.name, scope)
			} else if (binding?.kind === 'normal') {
				const visit = (value: unknown) => {
					if (!value || typeof value !== 'object') return
					const object = value as Record<string, unknown>
					if (object.kind === 'ident' && typeof object.name === 'string') {
						scope.add(object.name)
						clearImport(object.name, scope)
					}
					if (typeof object.sinkIdent === 'string') {
						scope.add(object.sinkIdent)
						clearImport(object.sinkIdent, scope)
					}
					Object.values(object).forEach(visit)
				}
				visit(binding.pattern)
			}
		} else if (expr.kind === 'moduleImport') {
			if (expr.imports?.kind === 'wildcard') {
				scope.add('*')
				for (const value of scope) if (value.startsWith('$import\0')) scope.delete(value)
			} else if (expr.imports?.kind === 'items')
				for (const item of expr.imports.items)
					scope.add(item.kind === 'renamed' ? item.newName : item.name)
			else if (expr.newName) scope.add(expr.newName)
			else if (expr.source.kind === 'str')
				scope.add(
					expr.source.value
						.split('/')
						.at(-1)!
						.replace(/\.typ$/, ''),
				)
			if (expr.source.kind === 'str') {
				const module = resolvePath(expr.source.value)
				if (module && expr.imports?.kind === 'items')
					for (const item of expr.imports.items)
						bind(
							scope,
							item.kind === 'renamed' ? item.newName : item.name,
							module,
							item.path.join('.'),
						)
				else if (module && !expr.imports)
					bind(
						scope,
						expr.newName ??
							expr.source.value
								.split('/')
								.at(-1)!
								.replace(/\.typ$/, ''),
						module,
					)
			}
		}
	}
	const builtin = (call: AstFuncCall, scope: Set<string>) => {
		const name = callName(call)
		return name && !scope.has('*') && !scope.has(name.split('.')[0]!) ? name : undefined
	}
	const charSpans = (expr: AstExpr, text: string) => {
		const range = rangeOf(expr, false)
		if (slice(range) !== text) return [{ ...range, text }]
		let from = range.from
		return [...text].map((character) => {
			const to = from + new TextEncoder().encode(character).length
			const span = { from, to, text: character }
			from = to
			return span
		})
	}
	const text = (expr: AstExpr, value: string, marks: Mark[]): Built[] =>
		value
			? [
					make(
						{ type: 'text', text: value, ...(marks.length > 0 ? { marks } : {}) },
						rangeOf(expr, false),
						[],
						{ textSpans: charSpans(expr, value) },
					),
				]
			: []
	const mergeText = (nodes: Built[]): Built[] => {
		const result: Built[] = []
		for (const item of nodes) {
			const prior = result.at(-1)
			if (
				prior?.node.type === 'text' &&
				item.node.type === 'text' &&
				same(prior.node.marks ?? [], item.node.marks ?? [])
			) {
				prior.node.text += item.node.text!
				prior.origin.to = item.origin.to
				prior.origin.preserve ||=
					item.origin.preserve || hasComments({ from: prior.origin.from, to: item.origin.to })
				prior.origin.textSpans = [
					...(prior.origin.textSpans ?? []),
					...(item.origin.textSpans ?? []),
				]
				prior.origin.markOrigins = [
					...(prior.origin.markOrigins ?? []),
					...(item.origin.markOrigins ?? []),
				]
			} else result.push(item)
		}
		return result
	}
	const withMark = (marks: Mark[], mark: Mark): Mark[] => {
		const previous = marks.find((value) => value.type === mark.type)
		return [
			...marks.filter((value) => value.type !== mark.type),
			previous && mark.type === 'textStyle'
				? { type: 'textStyle', attrs: { ...previous.attrs, ...mark.attrs } }
				: mark,
		]
	}
	const markBody = (
		expr: AstExpr,
		body: AstExpr[],
		scope: Set<string>,
		marks: Mark[],
		mark: Mark,
		bodyRange: TypstSourceRange,
		preserve = false,
		attributes?: Record<string, TypstSourceRange>,
	): Built[] => {
		const nodes = inline(body, new Set(scope), withMark(marks, mark))
		const argumentRanges: Record<string, TypstSourceRange> = {}
		if (expr.kind === 'funcCall' && preserve && mark.type === 'textStyle') {
			const args =
				cstNodes
					.get(`FuncCall:${expr.range![0]}:${expr.range![1]}`)
					?.children.find((node) => node.kind === 'Args')?.children ?? []
			for (let index = 0; index < args.length; index++) {
				const arg = args[index]!
				if (arg.kind !== 'Named') continue
				const name = arg.children[0]?.text,
					attribute =
						name === 'font'
							? 'fontFamily'
							: name === 'size'
								? 'fontSize'
								: name === 'fill'
									? callName(expr) === 'highlight'
										? 'backgroundColor'
										: 'color'
									: undefined
				if (!attribute) continue
				const next = args.slice(index + 1).find((node) => node.kind !== 'Space'),
					previous = args
						.slice(0, index)
						.toReversed()
						.find((node) => node.kind !== 'Space')
				if (
					next?.kind === 'LineComment' ||
					next?.kind === 'BlockComment' ||
					previous?.kind === 'LineComment' ||
					previous?.kind === 'BlockComment'
				)
					continue
				argumentRanges[attribute] = {
					from:
						previous?.kind === 'Comma' && next?.kind !== 'Comma' ? previous.range[0] : arg.range[0],
					to: next?.kind === 'Comma' ? next.range[1] : arg.range[1],
				}
			}
		}
		for (const node of nodes)
			node.origin.markOrigins = [
				...(node.origin.markOrigins ?? []),
				{
					...(expr.kind === 'funcCall' ? { callee: callName(expr) } : {}),
					mark,
					...rangeOf(expr),
					contentRange: bodyRange,
					shared: nodes.length !== 1,
					preserve,
					attributes,
					argumentRanges,
					...(expr.kind === 'funcCall' ? { insertion: callInsertion(expr) } : {}),
				},
			]
		return nodes
	}
	const contentArg = (call: AstFuncCall): AstContentBlock | undefined =>
		positional(call).find((arg): arg is AstContentBlock => arg.kind === 'contentBlock')
	const inline = (expressions: AstExpr[], scope: Set<string>, marks: Mark[] = []): Built[] =>
		mergeText(
			expressions
				.flatMap((expr): Built[] => {
					if (invalidExpressions.has(expr)) return [sourceNode(expr, true, 'invalid')]
					if (environment.has(expr.kind)) {
						shadowNames(expr, scope)
						return [sourceNode(expr, true, 'environment')]
					}
					switch (expr.kind) {
						case 'text':
							return text(expr, expr.text, marks)
						case 'space':
							return text(expr, ' ', marks)
						case 'escape':
						case 'shorthand':
							return text(expr, expr.character, marks)
						case 'smartQuote':
							return text(expr, expr.double ? '"' : "'", marks)
						case 'strong':
							return markBody(
								expr,
								expr.body,
								scope,
								marks,
								{ type: 'bold' },
								{ from: expr.range![0] + 1, to: expr.range![1] - 1 },
							)
						case 'emph':
							return markBody(
								expr,
								expr.body,
								scope,
								marks,
								{ type: 'italic' },
								{ from: expr.range![0] + 1, to: expr.range![1] - 1 },
							)
						case 'linebreak':
							return [make({ type: 'hardBreak' }, rangeOf(expr))]
						case 'raw':
							if (expr.lines.length === 0 || !expr.lines.join('\n'))
								return [sourceNode(expr, true, 'code')]
							return [
								make(
									{
										type: 'text',
										text: expr.lines.join('\n'),
										marks: [...marks, { type: 'code' }],
									},
									rangeOf(expr),
									[],
									{ textEncoding: { kind: 'raw', range: rangeOf(expr), canUnwrap: true } },
								),
							]
						case 'link':
							return text(expr, expr.url, [...marks, { type: 'link', attrs: { href: expr.url } }])
						case 'ref': {
							if (expr.supplement?.length) return [sourceNode(expr, true, 'reference')]
							return [
								make(
									{ type: 'reference', attrs: { target: expr.target, showCaption: null } },
									rangeOf(expr),
								),
							]
						}
						case 'funcCall': {
							const name = builtin(expr, scope),
								body = contentArg(expr)
							const declaration = helper(expr, scope)
							if (declaration?.library) {
								const args = positional(expr),
									first = args[0]
								if (
									declaration.name === 'latex' &&
									first?.kind === 'str' &&
									(!named(expr, 'block') ||
										(named(expr, 'block')?.kind === 'bool' &&
											!(named(expr, 'block') as { value: boolean }).value))
								)
									return [
										make({ type: 'inlineMath', attrs: { latex: first.value } }, rangeOf(expr), [], {
											preserve: true,
											attributeRanges: { latex: rangeOf(first, false) },
											call: { callee: declaration.callee, parameters: {}, ...callInsertion(expr) },
										}),
									]
								if (
									declaration.name === 'field' &&
									first?.kind === 'funcCall' &&
									builtin(first, scope) === 'json' &&
									args[1]?.kind === 'array'
								) {
									const file = positional(first)[0],
										keys = args[1].items
									if (
										file?.kind === 'str' &&
										keys.every(
											(key) => key.kind === 'pos' && ['str', 'int'].includes(key.expr.kind),
										)
									) {
										const path = resolvePath(file.value)
										if (path)
											return [
												make(
													{
														type: 'typstField',
														attrs: {
															file: path,
															path: keys.map(
																(key) => (key.expr as { value: string | number }).value,
															),
															source: slice(rangeOf(expr)),
														},
													},
													rangeOf(expr),
													[],
													{ preserve: true },
												),
											]
									}
								}
								if (declaration.name === 'reference' && first?.kind === 'label') {
									const caption = named(expr, 'caption')
									if (!caption || caption.kind === 'auto' || caption.kind === 'bool') {
										references.push({
											...rangeOf(first, false),
											path: input.path,
											label: first.name,
											syntax: 'label',
										})
										return [
											make(
												{
													type: 'reference',
													attrs: {
														target: first.name,
														showCaption: caption?.kind === 'bool' ? caption.value : null,
													},
												},
												rangeOf(expr),
												[],
												{
													preserve: true,
													attributeRanges: {
														target: rangeOf(first, false),
														...(caption ? { showCaption: rangeOf(caption, false) } : {}),
													},
													call: {
														callee: declaration.callee,
														parameters: {},
														...callInsertion(expr),
													},
												},
											),
										]
									}
								}
							}

							if (name === 'raw') {
								const value = positional(expr)[0]
								if (value?.kind === 'str' && value.value)
									return [
										make(
											{ type: 'text', text: value.value, marks: [...marks, { type: 'code' }] },
											rangeOf(expr),
											[],
											{
												textEncoding: {
													kind: 'string',
													range: rangeOf(value, false),
													canUnwrap: expr.args.length === 1,
												},
											},
										),
									]
								if (
									value?.kind === 'funcCall' &&
									expr.args.length === 1 &&
									helper(value, scope)?.name === 'field'
								) {
									const children = inline([value], scope, withMark(marks, { type: 'code' })),
										field = children[0]
									if (children.length === 1 && field?.node.type === 'typstField') {
										field.node.attrs!.source = `#${slice(rangeOf(value, false))}`
										Object.assign(field.origin, rangeOf(expr), {
											textEncoding: {
												kind: 'expression',
												range: rangeOf(value, false),
												canUnwrap: true,
											},
										})
										return children
									}
								}
							}
							if (body) {
								let mark: Mark | undefined
								if (name === 'strong') mark = { type: 'bold' }
								else if (name === 'emph') mark = { type: 'italic' }
								else if (name === 'strike' || name === 'underline') mark = { type: name }
								else if (name === 'link') {
									const href = positional(expr)[0]
									if (href?.kind === 'str') mark = { type: 'link', attrs: { href: href.value } }
								} else if (name === 'text' || name === 'highlight') {
									const attrs: Record<string, unknown> = {}
									const font = named(expr, 'font'),
										size = named(expr, 'size'),
										fill = named(expr, 'fill')
									if (font?.kind === 'str') attrs.fontFamily = font.value
									if (size?.kind === 'numeric' && size.unit === 'pt')
										attrs.fontSize = `${size.value}pt`
									if (
										fill?.kind === 'ident' &&
										[
											'black',
											'gray',
											'silver',
											'white',
											'navy',
											'blue',
											'aqua',
											'teal',
											'red',
											'maroon',
											'yellow',
											'olive',
											'lime',
											'green',
											'fuchsia',
											'purple',
											'orange',
										].includes(fill.name)
									) {
										if (scope.has(fill.name)) return [sourceNode(expr, true)]
										attrs[name === 'highlight' ? 'backgroundColor' : 'color'] = fill.name
									} else if (fill?.kind === 'funcCall' && callName(fill) === 'rgb') {
										if (builtin(fill, scope) !== 'rgb') return [sourceNode(expr, true)]
										const values = positional(fill),
											color = values[0],
											attribute = name === 'highlight' ? 'backgroundColor' : 'color'
										if (
											color?.kind === 'str' &&
											/^#?(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(color.value)
										)
											attrs[attribute] = color.value.startsWith('#')
												? color.value
												: `#${color.value}`
										else if (
											values.length >= 3 &&
											values
												.slice(0, 3)
												.every(
													(value) => value.kind === 'int' && value.value >= 0 && value.value <= 255,
												)
										) {
											const channels = values
													.slice(0, 3)
													.map((value) => (value as { value: number }).value),
												alpha = values[3]
											if (!alpha) attrs[attribute] = `rgb(${channels.join(', ')})`
											else if (
												alpha.kind === 'numeric' &&
												alpha.unit === 'percent' &&
												alpha.value >= 0 &&
												alpha.value <= 100
											)
												attrs[attribute] = `rgba(${channels.join(', ')}, ${alpha.value / 100})`
										}
									}
									mark = { type: 'textStyle', attrs }
								}
								if (mark) {
									if (mark.type === 'textStyle' && Object.keys(mark.attrs ?? {}).length === 0)
										return inline(body.body, new Set(scope), marks)
									const attributes: Record<string, TypstSourceRange> = {}
									if (mark.type === 'link') {
										const href = positional(expr)[0]
										if (href?.range) attributes.href = rangeOf(href, false)
									}
									for (const [attribute, argument] of Object.entries({
										fontFamily: 'font',
										fontSize: 'size',
										[name === 'highlight' ? 'backgroundColor' : 'color']: 'fill',
									})) {
										const value = named(expr, argument)
										if (value?.range) attributes[attribute] = rangeOf(value, false)
									}
									return markBody(
										expr,
										body.body,
										new Set(scope),
										marks,
										mark,
										{ from: body.range![0] + 1, to: body.range![1] - 1 },
										name === 'text' ||
											(name === 'highlight' &&
												expr.args.some((arg) => arg.kind === 'named' && arg.name !== 'fill')),
										attributes,
									)
								}
							}
							return [sourceNode(expr, true)]
						}
						default:
							return [sourceNode(expr, true)]
					}
				})
				.map((entry) => {
					if (entry.node.type !== 'text' && marks.length > 0)
						entry.node.marks = (entry.node.marks ?? []).reduce(
							(current, mark) => withMark(current, mark),
							marks,
						)
					return entry
				}),
		)
	const contentRange = (block: AstContentBlock): TypstSourceRange => ({
		from: block.range![0] + 1,
		to: block.range![1] - 1,
	})
	const table = (expr: AstFuncCall, scope: Set<string>): Built | undefined => {
		const columns = named(expr, 'columns')
		const count =
			columns?.kind === 'int'
				? columns.value
				: columns?.kind === 'array'
					? columns.items.length
					: undefined
		const columnSources =
			columns?.kind === 'array'
				? columns.items.map((item) => (item.expr.range ? slice(rangeOf(item.expr, false)) : '1fr'))
				: Array.from({ length: count ?? 0 }, () => '1fr')
		if (!count || count < 1 || count > 100 || expr.args.some((arg) => arg.kind === 'spread'))
			return undefined
		const rows: Built[][] = [],
			occupied = new Set<string>(),
			lines: { y: number; stroke: string }[] = []
		let openSides = false
		let row = 0,
			col = 0
		let invalid = false
		const cell = (value: AstExpr, header: boolean) => {
			if (value.kind === 'funcCall' && builtin(value, scope) === 'table.hline') {
				const y = named(value, 'y'),
					stroke = named(value, 'stroke')
				if (y?.kind === 'int' && stroke?.range)
					lines.push({ y: y.value, stroke: slice(rangeOf(stroke, false)).replaceAll(/\s/g, '') })
				else invalid = true
				return
			}

			let body: AstContentBlock | undefined,
				colspan = 1,
				rowspan = 1,
				range = rangeOf(value, false)
			if (value.kind === 'contentBlock') body = value
			else if (value.kind === 'funcCall' && builtin(value, scope) === 'table.cell') {
				body = contentArg(value)
				const x = named(value, 'x'),
					y = named(value, 'y'),
					c = named(value, 'colspan'),
					r = named(value, 'rowspan')
				if (
					(x && x.kind !== 'int') ||
					(y && y.kind !== 'int') ||
					(c && c.kind !== 'int') ||
					(r && r.kind !== 'int')
				) {
					invalid = true
					return
				}
				if (c?.kind === 'int') colspan = c.value
				if (r?.kind === 'int') rowspan = r.value
				if (x?.kind === 'int') col = x.value
				if (y?.kind === 'int') row = y.value
				if ((x || y) && occupied.has(`${row}:${col}`)) {
					invalid = true
					return
				}
				const stroke = named(value, 'stroke')
				if (
					stroke?.kind === 'dict' &&
					stroke.items.some(
						(item) =>
							item.kind === 'named' &&
							['left', 'right'].includes(item.name) &&
							item.expr.kind === 'none',
					)
				)
					openSides = true
			} else {
				invalid = true
				return
			}
			if (!body || colspan < 1 || rowspan < 1) {
				invalid = true
				return
			}
			while (occupied.has(`${row}:${col}`) || col >= count) {
				if (++col >= count) {
					row++
					col = 0
				}
			}
			if (col + colspan > count) {
				invalid = true
				return
			}
			for (let y = row; y < row + rowspan; y++)
				for (let x = col; x < col + colspan; x++) {
					if (occupied.has(`${y}:${x}`)) invalid = true
					occupied.add(`${y}:${x}`)
				}
			const children = blocks(body.body, new Set(scope), contentRange(body))
			const alignment = value.kind === 'funcCall' ? named(value, 'align') : undefined
			const node = make(
				{
					type: header ? 'tableHeader' : 'tableCell',
					attrs: {
						colspan,
						rowspan,
						...(alignment?.kind === 'ident' &&
						['left', 'center', 'right'].includes(alignment.name) &&
						!scope.has(alignment.name)
							? { align: alignment.name }
							: {}),
						colwidth:
							columns?.kind === 'array' &&
							columns.items
								.slice(col, col + colspan)
								.every((item) => item.expr.kind === 'numeric' && item.expr.unit === 'pt')
								? columns.items
										.slice(col, col + colspan)
										.map((item) => (item.expr as { value: number }).value / 0.75)
								: null,
					},
				},
				range,
				children,
				{
					contentRange: contentRange(body),
					rewriteBody: true,
					preserve: hasComments(range) || value.kind === 'funcCall',
				},
			)
			if (value.kind === 'funcCall') {
				const args = cstNodes
					.get(`FuncCall:${value.range![0]}:${value.range![1]}`)
					?.children.find((child) => child.kind === 'Args')
				node.origin.cell = {
					parameters:
						args?.children
							.filter((child) => child.kind === 'Named')
							.map((child) => sourceSlice(parsed, ...child.range)) ?? [],
				}
			}
			;(rows[row] ??= []).push(node)
			col += colspan
		}
		for (const value of positional(expr)) {
			if (
				value.kind === 'funcCall' &&
				['table.header', 'table.footer'].includes(builtin(value, scope) ?? '')
			) {
				for (const entry of positional(value)) cell(entry, builtin(value, scope) === 'table.header')
			} else cell(value, false)
		}
		if (invalid || rows.length === 0) return undefined
		for (let y = 0; y < rows.length; y++)
			for (let x = 0; x < count; x++) if (!occupied.has(`${y}:${x}`)) return undefined
		const children = rows.map((cells) =>
			make(
				{ type: 'tableRow' },
				{ from: cells[0]!.origin.from, to: cells.at(-1)!.origin.to },
				cells,
			),
		)
		const findCall = (node: typeof parsed.cst): typeof parsed.cst | undefined => {
			if (
				node.kind === 'FuncCall' &&
				node.range[0] === expr.range![0] &&
				node.range[1] === expr.range![1]
			)
				return node
			for (const child of node.children) {
				const found = findCall(child)
				if (found) return found
			}
			return undefined
		}
		const args = findCall(parsed.cst)?.children.find((node) => node.kind === 'Args')
		const parameters =
			args?.children
				.filter((node) => node.kind === 'Named')
				.map((node) => sourceSlice(parsed, ...node.range)) ?? []
		const strokeExpr = named(expr, 'stroke'),
			stroke = strokeExpr?.range
				? slice(rangeOf(strokeExpr, false)).replaceAll(/\s/g, '')
				: undefined
		const threeLine =
			stroke === 'none' &&
			lines.some((line) => line.y === 0 && line.stroke === '1pt+black') &&
			lines.some((line) => line.y === rows.length && line.stroke === '1pt+black')
		const appearance = threeLine
			? 'three-line'
			: stroke === 'none' && lines.length === 0
				? 'borderless'
				: ['.5pt+black', '0.5pt+black'].includes(stroke ?? '')
					? openSides
						? 'grid-open-sides'
						: 'grid'
					: null
		return make({ type: 'table', attrs: { tableStyle: appearance } }, rangeOf(expr), children, {
			preserve: true,
			table: {
				parameters,
				columns: count,
				columnSources,
				canRebuild: !hasComments(rangeOf(expr)) && (lines.length === 0 || threeLine),
			},
		})
	}
	const blockCall = (expr: AstFuncCall, scope: Set<string>): Built | undefined => {
		const name = builtin(expr, scope)
		const declaration = helper(expr, scope)
		if (declaration?.library && declaration.name === 'latex') {
			const value = positional(expr)[0],
				block = named(expr, 'block')
			if (value?.kind === 'str' && block?.kind === 'bool' && block.value)
				return make(
					{
						type: 'blockMath',
						attrs: { latex: value.value, id: `source-${expr.range![0]}`, label: null },
					},
					rangeOf(expr),
					[],
					{ preserve: true, attributeRanges: { latex: rangeOf(value, false) } },
				)
		}
		const component =
			declaration &&
			input.components?.find(
				(value) => value.module === declaration.module && value.name === declaration.name,
			)
		if (component) {
			const props: Record<string, unknown> = {},
				ranges: Record<string, TypstSourceRange> = {}
			for (const [parameterName, definition] of Object.entries(component.parameters)) {
				const value = named(expr, parameterName)
				if (value?.range) ranges[parameterName] = rangeOf(value, false)
				if (!value || !['str', 'bool', 'int', 'float'].includes(value.kind)) continue
				const literal = (value as { value: unknown }).value
				if (typeof literal === definition.type) {
					props[parameterName] = literal
					ranges[parameterName] = rangeOf(value, false)
				}
			}
			let binding: { file: string; source: string } | undefined
			const data = component.data && named(expr, component.data)
			if (data && data.kind === 'funcCall' && builtin(data, scope) === 'json') {
				const path = positional(data)[0]
				if (path?.kind === 'str') {
					const file = resolvePath(path.value)
					if (file) binding = { file, source: path.value }
				}
			}
			return make(
				{
					type: 'typstComponent',
					attrs: {
						module: component.module,
						name: component.name,
						label: component.label,
						parameters: component.parameters,
						props,
						binding: binding ?? null,
						source: slice(rangeOf(expr)),
					},
				},
				rangeOf(expr),
				[],
				{
					preserve: true,
					call: {
						callee: declaration!.callee,
						module: component.module,
						parameters: ranges,
						...callInsertion(expr),
					},
				},
			)
		}
		if (name === 'table') return table(expr, scope)
		if (name === 'par') {
			const body = contentArg(expr)
			if (
				body &&
				!body.body.some((child) => child.kind === 'parbreak' || environment.has(child.kind))
			)
				return make({ type: 'paragraph' }, rangeOf(expr), inline(body.body, new Set(scope)), {
					contentRange: contentRange(body),
					rewriteBody: true,
					preserve: true,
					call: { callee: 'par', ...callParameters(expr), ...callInsertion(expr) },
				})
		}
		if (name === 'list' || name === 'enum') {
			const items = positional(expr),
				start = named(expr, 'start'),
				numbering = named(expr, 'numbering')
			if (
				items.length === 0 ||
				items.some((item) => item.kind !== 'contentBlock') ||
				expr.args.some((arg) => arg.kind === 'spread') ||
				(start && start.kind !== 'int') ||
				(numbering && (numbering.kind !== 'str' || !/^[1aAiI]\.$/.test(numbering.value)))
			)
				return undefined
			const children = items.map((item) => {
				const body = item as AstContentBlock
				return make(
					{ type: 'listItem' },
					rangeOf(body, false),
					blocks(body.body, new Set(scope), contentRange(body)),
					{ contentRange: contentRange(body), rewriteBody: true, preserve: true },
				)
			})
			const parameters =
				cstNodes
					.get(`FuncCall:${expr.range![0]}:${expr.range![1]}`)
					?.children.find((node) => node.kind === 'Args')
					?.children.filter((node) => node.kind === 'Named')
					.map((node) => sourceSlice(parsed, ...node.range)) ?? []
			return make(
				{
					type: name === 'list' ? 'bulletList' : 'orderedList',
					...(name === 'enum'
						? {
								attrs: {
									start: start?.kind === 'int' ? start.value : 1,
									type: numbering?.kind === 'str' ? numbering.value[0] : null,
								},
							}
						: {}),
				},
				rangeOf(expr),
				children,
				{
					preserve: true,
					call: { callee: name, ...callParameters(expr), ...callInsertion(expr) },
					list: { parameters, canRebuild: !hasComments(rangeOf(expr)) },
				},
			)
		}
		if (name === 'line')
			return make({ type: 'horizontalRule' }, rangeOf(expr), [], { preserve: true })
		if (
			name === 'quote' &&
			named(expr, 'block')?.kind === 'bool' &&
			(named(expr, 'block') as { value: boolean }).value
		) {
			const body = contentArg(expr)
			if (body)
				return make(
					{ type: 'blockquote' },
					rangeOf(expr),
					blocks(body.body, new Set(scope), contentRange(body)),
					{ contentRange: contentRange(body), rewriteBody: true, preserve: true },
				)
		}
		if (
			name === 'raw' &&
			named(expr, 'block')?.kind === 'bool' &&
			(named(expr, 'block') as { value: boolean }).value
		) {
			const value = positional(expr)[0],
				language = named(expr, 'lang')
			if (value?.kind === 'str')
				return make(
					{
						type: 'codeBlock',
						attrs: { language: language?.kind === 'str' ? language.value : null },
						content: [{ type: 'text', text: value.value }],
					},
					rangeOf(expr),
					[],
					{
						preserve: true,
						textEncoding: { kind: 'string', range: rangeOf(value, false), canUnwrap: false },
					},
				)
		}
		if (name === 'image') {
			const path = positional(expr)[0]
			if (path?.kind !== 'str') return undefined
			const width = named(expr, 'width'),
				height = named(expr, 'height'),
				alt = named(expr, 'alt')
			return make(
				{
					type: 'image',
					attrs: {
						src: path.value,
						alt: alt?.kind === 'str' ? alt.value : null,
						title: null,
						width: width?.kind === 'numeric' && width.unit === 'pt' ? width.value / 0.75 : null,
						height: height?.kind === 'numeric' && height.unit === 'pt' ? height.value / 0.75 : null,
					},
				},
				rangeOf(expr),
				[],
				{
					preserve: true,
					attributeRanges: { src: rangeOf(path, false) },
					call: { callee: 'image', ...callParameters(expr), ...callInsertion(expr) },
				},
			)
		}
		if (name === 'figure') {
			const bodyExpr = positional(expr)[0],
				captionExpr = named(expr, 'caption')
			if (!bodyExpr || (captionExpr && captionExpr.kind !== 'contentBlock')) return undefined
			let body = bodyExpr.kind === 'funcCall' ? blockCall(bodyExpr, scope) : undefined
			if (!body && bodyExpr.kind === 'contentBlock') {
				const content = bodyExpr.body.filter((child) => !['space', 'parbreak'].includes(child.kind))
				if (content.length === 1 && content[0]!.kind === 'funcCall')
					body = blockCall(content[0]!, scope)
			}
			if (!body) body = sourceNode(bodyExpr, false, 'figure-body')
			const captionRange = captionExpr
				? contentRange(captionExpr as AstContentBlock)
				: { from: expr.range![1] - 1, to: expr.range![1] - 1 }
			const captionChildren =
				captionExpr?.kind === 'contentBlock' ? inline(captionExpr.body, new Set(scope)) : []
			const caption = make({ type: 'figureCaption' }, captionRange, captionChildren, {
				contentRange: captionRange,
				rewriteBody: true,
				...(!captionExpr
					? { call: { callee: 'figure-caption', parameters: {}, ...callInsertion(expr) } }
					: {}),
			})
			return make(
				{ type: 'figure', attrs: { id: `source-${expr.range![0]}`, label: null } },
				rangeOf(expr),
				[body, caption],
				{ preserve: true },
			)
		}
		if (name === 'align') {
			const body = contentArg(expr),
				alignment = positional(expr)[0]
			if (
				body &&
				alignment?.kind === 'ident' &&
				['left', 'center', 'right', 'start'].includes(alignment.name) &&
				!scope.has(alignment.name)
			) {
				const first = body.body.find((child) => child.kind !== 'space')
				const rule =
					first?.kind === 'setRule' && first.target.kind === 'ident' && first.target.name === 'par'
						? first
						: undefined
				const justify = rule?.args.find(
					(arg) => arg.kind === 'named' && arg.name === 'justify',
				)?.expr
				if (rule && scope.has('par')) return undefined
				if (rule && (justify?.kind !== 'bool' || rule.args.length !== 1)) return undefined
				if (alignment.name === 'start' && !(justify?.kind === 'bool' && justify.value))
					return undefined
				const children = blocks(
					rule ? body.body.filter((child) => child !== rule) : body.body,
					new Set(scope),
					contentRange(body),
				)
				if (children.length === 1 && ['paragraph', 'heading'].includes(children[0]!.node.type!)) {
					const child = children[0]!,
						bodyRange = { from: child.origin.from, to: child.origin.to }
					child.node.attrs = {
						...child.node.attrs,
						textAlign: justify?.kind === 'bool' && justify.value ? 'justify' : alignment.name,
					}
					child.origin.from = rangeOf(expr).from
					child.origin.to = rangeOf(expr).to
					child.origin.contentRange ??= bodyRange
					child.origin.rewriteBody = true
					child.origin.preserve = true
					child.origin.alignment = {
						alignment: rangeOf(alignment, false),
						...(justify ? { justify: rangeOf(justify, false) } : {}),
						...(rule ? { rule: rangeOf(rule) } : {}),
						body: contentRange(body),
					}
					return child
				}
			}
		}

		return undefined
	}
	const onOwnLine = (expr: AstExpr) => {
		const range = rangeOf(expr),
			start = parsed.byteToUtf16.get(range.from)!,
			end = parsed.byteToUtf16.get(range.to)!
		const before = input.source.slice(input.source.lastIndexOf('\n', start - 1) + 1, start)
		const newline = input.source.indexOf('\n', end)
		const after = input.source.slice(end, newline < 0 ? undefined : newline)
		return !before.trim() && (!after.trim() || /^\s*(?:\/\*.*?\*\/\s*)?<[^>]+>\s*$/.test(after))
	}
	function blocks(
		expressions: AstExpr[],
		inherited: Set<string>,
		owner: TypstSourceRange,
	): Built[] {
		const scope = new Set(inherited),
			output: Built[] = []
		let paragraph: AstExpr[] = []
		const flush = () => {
			while (paragraph[0]?.kind === 'space' && /[\r\n]/.test(slice(rangeOf(paragraph[0], false))))
				paragraph.shift()
			while (
				paragraph.at(-1)?.kind === 'space' &&
				/[\r\n]/.test(slice(rangeOf(paragraph.at(-1)!, false)))
			)
				paragraph.pop()
			if (paragraph.length === 0) return
			const range = { from: rangeOf(paragraph[0]!).from, to: rangeOf(paragraph.at(-1)!).to }
			output.push(
				make({ type: 'paragraph' }, range, inline(paragraph, new Set(scope)), {
					contentRange: range,
					preserve:
						hasComments(range) ||
						paragraph.some((expr) => expr.kind === 'funcCall' && !!contentArg(expr)),
				}),
			)
			paragraph = []
		}
		for (let index = 0; index < expressions.length; index++) {
			const expr = expressions[index]!
			if (expr.kind === 'parbreak') {
				flush()
				continue
			}
			if (invalidExpressions.has(expr)) {
				if (onOwnLine(expr)) {
					flush()
					output.push(sourceNode(expr, false, 'invalid'))
				} else paragraph.push(expr)
				continue
			}
			if (environment.has(expr.kind)) {
				flush()
				output.push(sourceNode(expr, false, 'environment'))
				shadowNames(expr, scope)
				continue
			}
			if (
				expr.kind === 'label' &&
				output.length > 0 &&
				!paragraph.some((node) => node.kind !== 'space')
			) {
				const previous = output.at(-1)!,
					label = labels.find((value) => value.from === expr.range?.[0])
				if (
					(['figure', 'heading', 'blockMath'].includes(previous.node.type!) ||
						previous.node.attrs?.role === 'math') &&
					!parsed.cst.children.some(
						(node) =>
							node.kind === 'Parbreak' &&
							node.range[0] >= previous.origin.to &&
							node.range[1] <= expr.range![0],
					)
				) {
					if (previous.node.type !== 'typstSource')
						previous.node.attrs = {
							...previous.node.attrs,
							label: expr.name,
							...(['figure', 'blockMath'].includes(previous.node.type!) ? { id: expr.name } : {}),
						}
					previous.origin.attributeRanges = {
						...previous.origin.attributeRanges,
						label: rangeOf(expr, false),
					}
					previous.origin.to = rangeOf(expr).to
					if (previous.node.type === 'typstSource')
						previous.node.attrs = { ...previous.node.attrs, source: slice(previous.origin) }
					if (label)
						label.target = {
							from: previous.origin.from,
							to: previous.origin.to,
							kind:
								previous.node.type === 'heading'
									? 'heading'
									: previous.node.attrs?.role === 'math' || previous.node.type === 'blockMath'
										? 'equation'
										: previous.node.content?.[0]?.type === 'table'
											? 'table'
											: 'figure',
							position: 0,
							title: plainText(previous.node.content?.at(-1) ?? previous.node),
						}
					paragraph = []
					continue
				}
			}
			if (expr.kind === 'heading') {
				flush()
				const range = rangeOf(expr),
					children = inline(
						expr.body.filter((child) => child.kind !== 'label'),
						new Set(scope),
					)
				const first = expr.body[0],
					last = expr.body.at(-1)
				const node = make({ type: 'heading', attrs: { level: expr.depth } }, range, children, {
					contentRange: { from: first?.range?.[0] ?? range.to, to: last?.range?.[1] ?? range.to },
					attributeRanges: { level: { from: range.from, to: range.from + expr.depth } },
				})
				output.push(node)
				const labelExpr = expr.body.find((child) => child.kind === 'label')
				if (labelExpr?.kind === 'label') {
					node.node.attrs!.label = labelExpr.name
					node.origin.attributeRanges = {
						...node.origin.attributeRanges,
						label: rangeOf(labelExpr, false),
					}
					const label = labels.find((value) => value.from === labelExpr.range?.[0])
					if (label)
						label.target = { ...range, kind: 'heading', position: 0, title: plainText(node.node) }
				}
				continue
			}
			if (expr.kind === 'listItem' || expr.kind === 'enumItem') {
				flush()
				const kind = expr.kind,
					items: Built[] = []
				let last = expr
				for (;;) {
					const item = expressions[index]!
					if (item.kind !== kind) break
					last = item
					items.push(
						make(
							{ type: 'listItem' },
							rangeOf(item),
							blocks(item.body, new Set(scope), rangeOf(item)),
							{ preserve: true },
						),
					)
					const next = expressions[index + 1]
					if (next?.kind === 'space' && expressions[index + 2]?.kind === kind) index++
					else if (next?.kind !== kind) break
					index++
				}
				output.push(
					make(
						{
							type: kind === 'enumItem' ? 'orderedList' : 'bulletList',
							...(kind === 'enumItem' ? { attrs: { start: expr.number ?? 1 } } : {}),
						},
						{ from: rangeOf(expr).from, to: rangeOf(last).to },
						items,
					),
				)
				continue
			}
			if (expr.kind === 'raw' && expr.block) {
				flush()
				output.push(
					make(
						{
							type: 'codeBlock',
							attrs: { language: expr.lang ?? null },
							content: expr.lines.length > 0 ? [{ type: 'text', text: expr.lines.join('\n') }] : [],
						},
						rangeOf(expr),
					),
				)
				continue
			}
			if (expr.kind === 'equation' && expr.block) {
				flush()
				output.push(sourceNode(expr, false, 'math'))
				continue
			}
			if (expr.kind === 'funcCall') {
				const name = builtin(expr, scope)
				if (name === 'math.equation' && onOwnLine(expr)) {
					flush()
					output.push(sourceNode(expr, false, 'math'))
					continue
				}
				if (
					[
						'figure',
						'table',
						'image',
						'align',
						'quote',
						'line',
						'raw',
						'list',
						'enum',
						'par',
					].includes(name ?? '') ||
					helper(expr, scope)
				) {
					const node = blockCall(expr, scope)
					if (node) {
						flush()
						output.push(node)
						continue
					}
				}
				if (
					onOwnLine(expr) &&
					!['text', 'strong', 'emph', 'strike', 'underline', 'link', 'highlight', 'raw'].includes(
						name ?? '',
					) &&
					!helper(expr, scope)?.library
				) {
					flush()
					output.push(sourceNode(expr, false))
					continue
				}
			}
			if (controls.has(expr.kind) && onOwnLine(expr)) {
				flush()
				output.push(sourceNode(expr, false, 'code'))
				continue
			}
			paragraph.push(expr)
		}
		flush()
		if (output.length === 0)
			output.push(make({ type: 'paragraph' }, { from: owner.from, to: owner.from }))
		return output
	}
	const builtNodes = blocks(rootExpressions, new Set(), { from: 0, to: byteLength })
	const mapping: TypstSourceMapping[] = []
	const place = (built: Built, path: number[], position: number): number => {
		built.origin.nodePath = path
		const node = built.node
		let size: number
		if (node.type === 'text') size = node.text?.length ?? 0
		else if (
			node.content ||
			['paragraph', 'heading', 'figureCaption', 'codeBlock'].includes(node.type!)
		) {
			let childPosition = position + 1
			for (let i = 0; i < (node.content?.length ?? 0); i++) {
				const child = node.content![i]!,
					origin = built.origin.children[i]
				if (origin) childPosition += place({ node: child, origin }, [...path, i], childPosition)
				else childPosition += child.text?.length ?? 1
			}
			size = childPosition - position + 1
		} else size = 1
		if (node.type === 'text' && built.origin.textSpans) {
			let from = position
			for (const span of built.origin.textSpans) {
				mapping.push({
					from: span.from,
					to: span.to,
					position: from,
					endPosition: from + span.text.length,
					nodePath: path,
					kind: 'text',
				})
				from += span.text.length
			}
		} else
			mapping.push({
				from: built.origin.from,
				to: built.origin.to,
				position,
				endPosition: position + size,
				nodePath: path,
				kind: node.type === 'text' ? 'text' : node.type?.includes('Source') ? 'source' : 'node',
			})
		for (const label of labels)
			if (label.target?.from === built.origin.from) label.target.position = position
		return size
	}
	let position = 0
	builtNodes.forEach((node, index) => {
		position += place(node, [index], position)
	})
	const rootScope = new Set<string>()
	parsed.ast.forEach((expr) => shadowNames(expr, rootScope))
	let libraryAlias: string | undefined
	for (const value of rootScope) {
		const parts = value.split('\0')
		if (parts[0] === '$import' && !parts[3] && isLibrary(parts[2]!)) libraryAlias = parts[1]
	}
	return {
		libraryAlias,
		components: input.components,
		path: input.path,
		revision: input.revision,
		source: input.source,
		document: { type: 'doc', content: builtNodes.map((entry) => entry.node) },
		mapping,
		labels,
		references,
		editable: parsed.errors.length === 0,
		diagnostics: parsed.errors.map((error) => ({
			code: 'SYNTAX_ERROR',
			severity: 'error',
			path: input.path,
			revision: input.revision,
			from: error.range[0],
			to: error.range[1],
			message: error.message,
		})),
		origins: builtNodes.map((entry) => entry.origin),
		parsed,
	}
}
