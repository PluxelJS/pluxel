import type { AstExpr } from '@r4ai/typst-ast-node'
import type { TypstParsedSource, TypstSourceParser } from './types.js'

/** 0.3.0's runtime uses snake_case for these fields although its declarations use camelCase. */
const runtimeKeys: Record<string, string> = {
	binding_kind: 'bindingKind',
	if_body: 'ifBody',
	else_body: 'elseBody',
	original_name: 'originalName',
	new_name: 'newName',
	sink_ident: 'sinkIdent',
	sink_expr: 'sinkExpr',
}
function normalizeAst(value: unknown): void {
	if (!value || typeof value !== 'object') return
	if (Array.isArray(value)) {
		value.forEach(normalizeAst)
		return
	}
	const object = value as Record<string, unknown>
	for (const key of Object.keys(object)) {
		const child = object[key]
		const name = runtimeKeys[key]
		if (name) {
			object[name] = child
			delete object[key]
		}
		normalizeAst(child)
	}
}

/** Source offsets are UTF-8 bytes. No slice operation accepts parser offsets as JS indexes. */
export function parseTypstSource(source: string, parser: TypstSourceParser): TypstParsedSource {
	if (!source.isWellFormed())
		throw new TypeError('Typst source contains an unpaired UTF-16 surrogate')
	const byteToUtf16 = new Map<number, number>([[0, 0]])
	const utf16ToByte = new Map<number, number>([[0, 0]])
	let byte = 0,
		utf16 = 0
	for (const character of source) {
		const point = character.codePointAt(0)!
		byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
		utf16 += character.length
		byteToUtf16.set(byte, utf16)
		utf16ToByte.set(utf16, byte)
	}
	const cst = parser.parse(source, { mode: 'markup' })
	const ast = parser.parseAst(source, { mode: 'markup' })
	normalizeAst(ast.root)
	return {
		source,
		cst: cst.root,
		ast: ast.root as AstExpr[],
		errors: cst.errors,
		byteToUtf16,
		utf16ToByte,
	}
}

export function sourceSlice(parsed: TypstParsedSource, from: number, to: number): string {
	const start = parsed.byteToUtf16.get(from),
		end = parsed.byteToUtf16.get(to)
	if (start === undefined || end === undefined)
		throw new RangeError('Source range splits a UTF-8 character')
	return parsed.source.slice(start, end)
}
