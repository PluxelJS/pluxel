import {
	layoutNextLine,
	measureNaturalWidth,
	type LayoutLine,
	type PreparedTextWithSegments,
} from '@chenglou/pretext'
import type { SKRSContext2D } from '@napi-rs/canvas'
import type { PrepareTextInput } from './contracts.ts'

/** Horizontal placement for text inside a table cell. */
export type CanvasTableTextAlign = 'left' | 'center' | 'right'

/** Behavior when a cell has more lines than its style permits. */
export type CanvasTableOverflow = 'clip' | 'ellipsis'

/** Complete visual defaults required for body cells. */
export type CanvasTableTextStyle = Readonly<{
	/** Canvas font shorthand used both for Pretext measurement and native drawing. */
	font: string
	/** Fixed pixel advance between wrapped lines. */
	lineHeight: number
	/** Inner cell inset in CSS pixels. @defaultValue 8 */
	padding?: number
	/** Canvas fill color for text. @defaultValue '#111827' */
	color?: string
	/** Optional fill drawn behind every cell using this style. */
	background?: string
	/** @defaultValue 'left' */
	textAlign?: CanvasTableTextAlign
	/** Maximum rendered lines per cell. @defaultValue 1 */
	maxLines?: number
	/** @defaultValue 'ellipsis' */
	overflow?: CanvasTableOverflow
}>

/** Partial text styling used by headers and individual cells. */
export type CanvasTableTextStyleOverride = Readonly<{
	font?: string
	lineHeight?: number
	padding?: number
	color?: string
	background?: string
	textAlign?: CanvasTableTextAlign
	maxLines?: number
	overflow?: CanvasTableOverflow
}>

/** A convenient scalar cell value or a locally styled cell. Format locale-sensitive values first. */
export type CanvasTableCellInput =
	| string
	| number
	| (Readonly<{
			text: string | number
	  }> &
			CanvasTableTextStyleOverride)

/** One visual column. Fixed-width columns consume `width`; all others share remaining width by `weight`. */
export type CanvasTableColumn = Readonly<{
	header?: CanvasTableCellInput
	width?: number
	weight?: number
	textAlign?: CanvasTableTextAlign
}>

/** Optional grid stroke. Both defaults are applied when the object is omitted. */
export type CanvasTableBorder = Readonly<{
	color?: string
	width?: number
}>

/** Prepares bounded text through CanvasPlugin or a detached worker text adapter. */
export type CanvasTableTextPreparer = (input: PrepareTextInput) => PreparedTextWithSegments

/** Declarative, allocation-free table input. */
export type CanvasTableInput = Readonly<{
	/** Horizontal canvas position. @defaultValue 0 */
	x?: number
	/** Vertical canvas position. @defaultValue 0 */
	y?: number
	/** Exact outer table width. Fixed columns consume it; flexible columns share the rest. */
	width: number
	columns: readonly CanvasTableColumn[]
	rows: readonly (readonly CanvasTableCellInput[])[]
	/** Required body typography. There is deliberately no global table theme. */
	body: CanvasTableTextStyle
	/** Header overrides applied only when at least one column has a header. */
	header?: CanvasTableTextStyleOverride
	border?: CanvasTableBorder
	/** Background used for zero-based odd body rows unless that cell overrides it. */
	alternateRowBackground?: string
	/** A bounded Pretext preparation callback; this utility never creates a Canvas or font registry. */
	prepareText: CanvasTableTextPreparer
}>

/** Immutable rectangle in canvas CSS pixels. */
export type CanvasTableBounds = Readonly<{
	x: number
	y: number
	width: number
	height: number
}>

/** A pre-measured, visible line. */
export type CanvasTableLine = Readonly<{
	text: string
	width: number
}>

/** Fully resolved styling stored on each layout cell. */
export type CanvasTableResolvedTextStyle = Readonly<{
	font: string
	lineHeight: number
	padding: number
	color: string
	background?: string
	textAlign: CanvasTableTextAlign
	maxLines: number
	overflow: CanvasTableOverflow
}>

export type CanvasTableHeaderCellLayout = Readonly<{
	kind: 'header'
	columnIndex: number
	text: string
	bounds: CanvasTableBounds
	contentBounds: CanvasTableBounds
	lines: readonly CanvasTableLine[]
	style: CanvasTableResolvedTextStyle
}>

export type CanvasTableBodyCellLayout = Readonly<{
	kind: 'body'
	rowIndex: number
	columnIndex: number
	text: string
	bounds: CanvasTableBounds
	contentBounds: CanvasTableBounds
	lines: readonly CanvasTableLine[]
	style: CanvasTableResolvedTextStyle
}>

export type CanvasTableCellLayout = CanvasTableHeaderCellLayout | CanvasTableBodyCellLayout

export type CanvasTableHeaderRowLayout = Readonly<{
	kind: 'header'
	bounds: CanvasTableBounds
	cells: readonly CanvasTableHeaderCellLayout[]
}>

export type CanvasTableBodyRowLayout = Readonly<{
	kind: 'body'
	rowIndex: number
	bounds: CanvasTableBounds
	cells: readonly CanvasTableBodyCellLayout[]
}>

export type CanvasTableColumnLayout = Readonly<{
	index: number
	x: number
	width: number
	textAlign?: CanvasTableTextAlign
}>

export type CanvasTableResolvedBorder = Readonly<{
	color: string
	width: number
}>

/** Immutable result of `layoutTable()`, suitable for one or more native drawing passes. */
export type CanvasTableLayout = Readonly<{
	bounds: CanvasTableBounds
	columns: readonly CanvasTableColumnLayout[]
	header?: CanvasTableHeaderRowLayout
	rows: readonly CanvasTableBodyRowLayout[]
	border: CanvasTableResolvedBorder
}>

/** A local drawing callback runs after a cell background and before its default text. */
export type CanvasTableCellPaintEvent = Readonly<{
	context: SKRSContext2D
	cell: CanvasTableCellLayout
}>

/** Returning this value suppresses only the default text pass for that cell. */
export type CanvasTableCellPaintResult = 'skip-text'

export type CanvasTableDrawOptions = Readonly<{
	paintCell?: (event: CanvasTableCellPaintEvent) => CanvasTableCellPaintResult | undefined
}>

type NormalizedCell = Readonly<{
	text: string
	style: CanvasTableTextStyleOverride
}>

type NormalizedColumn = Readonly<{
	header?: NormalizedCell
	width?: number
	weight?: number
	textAlign?: CanvasTableTextAlign
}>

type MeasuredCell = Readonly<{
	kind: 'header' | 'body'
	rowIndex?: number
	columnIndex: number
	text: string
	style: CanvasTableResolvedTextStyle
	lines: readonly CanvasTableLine[]
	height: number
}>

type MeasuredRow = Readonly<{
	kind: 'header' | 'body'
	rowIndex?: number
	cells: readonly MeasuredCell[]
	height: number
}>

const EMPTY_STYLE_OVERRIDE: CanvasTableTextStyleOverride = Object.freeze({})
const TEXT_STYLE_KEYS = new Set([
	'font',
	'lineHeight',
	'padding',
	'color',
	'background',
	'textAlign',
	'maxLines',
	'overflow',
])
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Compute a table snapshot without allocating a Canvas or retaining caller input.
 *
 * `prepareText` is called only for visible cell content. It should delegate to
 * `CanvasPlugin.prepareTextWithSegmentsSync()` on the root, or a worker text adapter in a task.
 */
export function layoutTable(input: CanvasTableInput): CanvasTableLayout {
	const normalized = normalizeInput(input)
	const columns = resolveColumns(normalized.columns, normalized.width, normalized.x)
	const hasHeader = normalized.columns.some((column) => column.header !== undefined)
	const headerStyle = resolveTextStyle(normalized.body, normalized.header)
	let y = normalized.y

	let header: CanvasTableHeaderRowLayout | undefined
	if (hasHeader) {
		const materialized = materializeRow(
			measureRow(
				'header',
				normalized.columns.map((column) => column.header ?? emptyCell()),
				columns,
				headerStyle,
				normalized.prepareText,
			),
			columns,
			normalized.x,
			y,
			normalized.width,
		)
		if (materialized.kind !== 'header') {
			throw new TypeError('Table header became a body row')
		}
		header = materialized
		y += header.bounds.height
	}

	const rows: CanvasTableBodyRowLayout[] = []
	for (const [rowIndex, row] of normalized.rows.entries()) {
		const baseStyle =
			normalized.alternateRowBackground !== undefined && rowIndex % 2 === 1
				? withBackground(normalized.body, normalized.alternateRowBackground)
				: normalized.body
		const measured = measureRow('body', row, columns, baseStyle, normalized.prepareText, rowIndex)
		const materialized = materializeRow(measured, columns, normalized.x, y, normalized.width)
		if (materialized.kind !== 'body') throw new TypeError('Body table row became a header row')
		rows.push(materialized)
		y += materialized.bounds.height
	}

	return Object.freeze({
		bounds: freezeBounds(normalized.x, normalized.y, normalized.width, y - normalized.y),
		columns: Object.freeze(columns),
		...(header === undefined ? {} : { header }),
		rows: Object.freeze(rows),
		border: normalized.border,
	})
}

/**
 * Draws a previously calculated table onto a caller-owned native context.
 *
 * The function creates no surface, performs no encoding, and restores the complete context state
 * even if `paintCell` throws. Each callback receives a saved context state that is restored before
 * default text or the next cell draws. The callback is deliberately local: it has no ordering, registration,
 * or lifecycle semantics beyond this draw pass.
 */
export function drawTable(
	context: SKRSContext2D,
	table: CanvasTableLayout,
	options: CanvasTableDrawOptions = {},
): void {
	if (!context || typeof context !== 'object' || typeof context.save !== 'function') {
		throw new TypeError('drawTable() requires a native Canvas 2D context')
	}
	if (!table || typeof table !== 'object') {
		throw new TypeError('drawTable() requires a layout returned by layoutTable()')
	}
	if (!options || typeof options !== 'object') {
		throw new TypeError('drawTable() options must be an object')
	}
	if (options.paintCell !== undefined && typeof options.paintCell !== 'function') {
		throw new TypeError('drawTable() paintCell must be a function')
	}

	context.save()
	try {
		for (const cell of tableCells(table)) {
			if (cell.style.background !== undefined) {
				context.fillStyle = cell.style.background
				context.fillRect(cell.bounds.x, cell.bounds.y, cell.bounds.width, cell.bounds.height)
			}
			let result: CanvasTableCellPaintResult | undefined
			if (options.paintCell !== undefined) {
				context.save()
				try {
					result = options.paintCell(Object.freeze({ context, cell }))
				} finally {
					context.restore()
				}
			}
			if (result !== undefined && result !== 'skip-text') {
				throw new TypeError('drawTable() paintCell must return skip-text or undefined')
			}
			if (result !== 'skip-text') drawCellText(context, cell)
		}
		drawGrid(context, table)
	} finally {
		context.restore()
	}
}

function normalizeInput(input: CanvasTableInput): Readonly<{
	x: number
	y: number
	width: number
	columns: readonly NormalizedColumn[]
	rows: readonly (readonly NormalizedCell[])[]
	body: CanvasTableResolvedTextStyle
	header: CanvasTableTextStyleOverride
	border: CanvasTableResolvedBorder
	alternateRowBackground?: string
	prepareText: CanvasTableTextPreparer
}> {
	if (!isRecord(input)) throw new TypeError('layoutTable() input must be an object')
	assertAllowedKeys(
		input,
		'layoutTable() input',
		new Set([
			'x',
			'y',
			'width',
			'columns',
			'rows',
			'body',
			'header',
			'border',
			'alternateRowBackground',
			'prepareText',
		]),
	)
	const x = readFinite(input, 'x', 0)
	const y = readFinite(input, 'y', 0)
	const width = readPositive(input, 'width')
	if (!Array.isArray(input.columns) || input.columns.length === 0) {
		throw new TypeError('layoutTable() columns must be a non-empty array')
	}
	if (!Array.isArray(input.rows)) throw new TypeError('layoutTable() rows must be an array')
	if (typeof input.prepareText !== 'function') {
		throw new TypeError('layoutTable() prepareText must be a function')
	}
	const columns = input.columns.map((column, index) => normalizeColumn(column, index))
	const rows = input.rows.map((row, rowIndex) => {
		if (!Array.isArray(row) || row.length !== columns.length) {
			throw new TypeError(
				`Table row ${rowIndex} must have exactly ${columns.length} cells, one for each column`,
			)
		}
		return Object.freeze(
			row.map((cell, columnIndex) => normalizeCell(cell, `${rowIndex}:${columnIndex}`)),
		)
	})
	const alternateRowBackground = readOptionalColor(input, 'alternateRowBackground')
	return Object.freeze({
		x,
		y,
		width,
		columns: Object.freeze(columns),
		rows: Object.freeze(rows),
		body: normalizeBodyStyle(input.body),
		header: normalizeTextStyleOverride(input.header, 'header'),
		border: normalizeBorder(input.border),
		...(alternateRowBackground === undefined ? {} : { alternateRowBackground }),
		prepareText: input.prepareText,
	})
}

function normalizeColumn(value: unknown, index: number): NormalizedColumn {
	if (!isRecord(value)) throw new TypeError(`Table column ${index} must be an object`)
	assertAllowedKeys(
		value,
		`Table column ${index}`,
		new Set(['header', 'width', 'weight', 'textAlign']),
	)
	const width = readOptionalPositive(value, 'width')
	const weight = readOptionalPositive(value, 'weight')
	if (width !== undefined && weight !== undefined) {
		throw new TypeError(`Table column ${index} cannot declare both width and weight`)
	}
	const header =
		hasOwn(value, 'header') && value.header !== undefined
			? normalizeCell(value.header, `header ${index}`)
			: undefined
	const textAlign = readOptionalTextAlign(value, 'textAlign')
	return Object.freeze({
		...(header === undefined ? {} : { header }),
		...(width === undefined ? {} : { width }),
		...(weight === undefined ? {} : { weight }),
		...(textAlign === undefined ? {} : { textAlign }),
	})
}

function normalizeCell(value: unknown, label: string): NormalizedCell {
	if (typeof value === 'string' || typeof value === 'number') {
		return Object.freeze({
			text: normalizeText(value, `Table cell ${label}`),
			style: EMPTY_STYLE_OVERRIDE,
		})
	}
	if (!isRecord(value))
		throw new TypeError(`Table cell ${label} must be a string, number, or object`)
	assertAllowedKeys(value, `Table cell ${label}`, new Set(['text', ...TEXT_STYLE_KEYS]))
	if (!hasOwn(value, 'text')) throw new TypeError(`Table cell ${label} requires text`)
	return Object.freeze({
		text: normalizeText(value.text, `Table cell ${label}`),
		style: normalizeTextStyleProperties(value, `Table cell ${label}`),
	})
}

function normalizeBodyStyle(value: unknown): CanvasTableResolvedTextStyle {
	const override = normalizeTextStyleOverride(value, 'body')
	if (override.font === undefined) throw new TypeError('Table body requires a font')
	if (override.lineHeight === undefined) throw new TypeError('Table body requires a lineHeight')
	const background = override.background
	return Object.freeze({
		font: override.font,
		lineHeight: override.lineHeight,
		padding: override.padding ?? 8,
		color: override.color ?? '#111827',
		...(background === undefined ? {} : { background }),
		textAlign: override.textAlign ?? 'left',
		maxLines: override.maxLines ?? 1,
		overflow: override.overflow ?? 'ellipsis',
	})
}

function normalizeTextStyleOverride(value: unknown, label: string): CanvasTableTextStyleOverride {
	if (value === undefined) return EMPTY_STYLE_OVERRIDE
	if (!isRecord(value)) throw new TypeError(`Table ${label} style must be an object`)
	assertAllowedKeys(value, `Table ${label} style`, TEXT_STYLE_KEYS)
	return normalizeTextStyleProperties(value, `Table ${label} style`)
}

function normalizeTextStyleProperties(
	value: Record<string, unknown>,
	label: string,
): CanvasTableTextStyleOverride {
	const font = readOptionalNonEmptyString(value, 'font', label)
	const lineHeight = readOptionalPositive(value, 'lineHeight')
	const padding = readOptionalNonNegative(value, 'padding')
	const color = readOptionalColor(value, 'color')
	const background = readOptionalColor(value, 'background')
	const textAlign = readOptionalTextAlign(value, 'textAlign')
	const maxLines = readOptionalPositiveInteger(value, 'maxLines')
	const overflow = readOptionalOverflow(value, 'overflow')
	return Object.freeze({
		...(font === undefined ? {} : { font }),
		...(lineHeight === undefined ? {} : { lineHeight }),
		...(padding === undefined ? {} : { padding }),
		...(color === undefined ? {} : { color }),
		...(background === undefined ? {} : { background }),
		...(textAlign === undefined ? {} : { textAlign }),
		...(maxLines === undefined ? {} : { maxLines }),
		...(overflow === undefined ? {} : { overflow }),
	})
}

function normalizeBorder(value: unknown): CanvasTableResolvedBorder {
	if (value === undefined) return Object.freeze({ color: '#d1d5db', width: 1 })
	if (!isRecord(value)) throw new TypeError('Table border must be an object')
	assertAllowedKeys(value, 'Table border', new Set(['color', 'width']))
	return Object.freeze({
		color: readOptionalColor(value, 'color') ?? '#d1d5db',
		width: readOptionalNonNegative(value, 'width') ?? 1,
	})
}

function resolveColumns(
	columns: readonly NormalizedColumn[],
	tableWidth: number,
	x: number,
): CanvasTableColumnLayout[] {
	let fixedWidth = 0
	let totalWeight = 0
	for (const column of columns) {
		if (column.width !== undefined) fixedWidth += column.width
		else totalWeight += column.weight ?? 1
	}
	if (fixedWidth > tableWidth) {
		throw new TypeError(
			`Fixed table columns require ${fixedWidth}px, exceeding table width ${tableWidth}px`,
		)
	}
	if (totalWeight === 0 && fixedWidth !== tableWidth) {
		throw new TypeError('All-fixed table columns must add up to the table width exactly')
	}
	const flexibleWidth = tableWidth - fixedWidth
	let currentX = x
	return columns.map((column, index) => {
		const width = column.width ?? (flexibleWidth * (column.weight ?? 1)) / totalWeight
		if (!(width > 0) || !Number.isFinite(width)) {
			throw new TypeError(`Table column ${index} has no positive width`)
		}
		const layout = Object.freeze({
			index,
			x: currentX,
			width,
			...(column.textAlign === undefined ? {} : { textAlign: column.textAlign }),
		})
		currentX += width
		return layout
	})
}

function measureRow(
	kind: 'header' | 'body',
	cells: readonly NormalizedCell[],
	columns: readonly CanvasTableColumnLayout[],
	baseStyle: CanvasTableResolvedTextStyle,
	prepareText: CanvasTableTextPreparer,
	rowIndex?: number,
): MeasuredRow {
	const measuredCells = cells.map((cell, columnIndex) => {
		const column = columns[columnIndex]!
		const columnOverride =
			column.textAlign === undefined
				? EMPTY_STYLE_OVERRIDE
				: Object.freeze({ textAlign: column.textAlign })
		const style = resolveTextStyle(baseStyle, columnOverride, cell.style)
		const contentWidth = column.width - style.padding * 2
		if (!(contentWidth > 0)) {
			throw new TypeError(
				`Table column ${columnIndex} leaves no text width after ${style.padding}px cell padding`,
			)
		}
		const lines = measureCellLines(cell.text, style, contentWidth, prepareText)
		return Object.freeze({
			kind,
			...(kind === 'body' ? { rowIndex } : {}),
			columnIndex,
			text: cell.text,
			style,
			lines,
			height: style.padding * 2 + Math.max(lines.length, 1) * style.lineHeight,
		})
	})
	return Object.freeze({
		kind,
		...(kind === 'body' ? { rowIndex } : {}),
		cells: Object.freeze(measuredCells),
		height: Math.max(...measuredCells.map((cell) => cell.height)),
	})
}

function materializeRow(
	row: MeasuredRow,
	columns: readonly CanvasTableColumnLayout[],
	x: number,
	y: number,
	width: number,
): CanvasTableHeaderRowLayout | CanvasTableBodyRowLayout {
	const bounds = freezeBounds(x, y, width, row.height)
	if (row.kind === 'header') {
		const cells = row.cells.map((cell) =>
			materializeHeaderCell(cell, columns[cell.columnIndex]!, y, row.height),
		)
		return Object.freeze({ kind: 'header', bounds, cells: Object.freeze(cells) })
	}
	const cells = row.cells.map((cell) =>
		materializeBodyCell(cell, columns[cell.columnIndex]!, y, row.height),
	)
	return Object.freeze({
		kind: 'body',
		rowIndex: row.rowIndex!,
		bounds,
		cells: Object.freeze(cells),
	})
}

function materializeHeaderCell(
	cell: MeasuredCell,
	column: CanvasTableColumnLayout,
	y: number,
	height: number,
): CanvasTableHeaderCellLayout {
	return Object.freeze({
		kind: 'header',
		columnIndex: cell.columnIndex,
		text: cell.text,
		bounds: freezeBounds(column.x, y, column.width, height),
		contentBounds: freezeBounds(
			column.x + cell.style.padding,
			y + cell.style.padding,
			column.width - cell.style.padding * 2,
			height - cell.style.padding * 2,
		),
		lines: cell.lines,
		style: cell.style,
	})
}

function materializeBodyCell(
	cell: MeasuredCell,
	column: CanvasTableColumnLayout,
	y: number,
	height: number,
): CanvasTableBodyCellLayout {
	return Object.freeze({
		kind: 'body',
		rowIndex: cell.rowIndex!,
		columnIndex: cell.columnIndex,
		text: cell.text,
		bounds: freezeBounds(column.x, y, column.width, height),
		contentBounds: freezeBounds(
			column.x + cell.style.padding,
			y + cell.style.padding,
			column.width - cell.style.padding * 2,
			height - cell.style.padding * 2,
		),
		lines: cell.lines,
		style: cell.style,
	})
}

function measureCellLines(
	text: string,
	style: CanvasTableResolvedTextStyle,
	width: number,
	prepareText: CanvasTableTextPreparer,
): readonly CanvasTableLine[] {
	if (text.length === 0) return Object.freeze([])
	const prepared = prepareText({ text, font: style.font })
	const lines: CanvasTableLine[] = []
	let cursor = { segmentIndex: 0, graphemeIndex: 0 }
	for (let index = 0; index < style.maxLines; index += 1) {
		const line = layoutNextLine(prepared, cursor, width)
		if (line === null) break
		lines.push(freezeLine(line))
		cursor = line.end
	}
	const hasMore =
		lines.length === style.maxLines && layoutNextLine(prepared, cursor, width) !== null
	if (hasMore && style.overflow === 'ellipsis' && lines.length > 0) {
		const lastIndex = lines.length - 1
		lines[lastIndex] = truncateLine(lines[lastIndex]!, width, style.font, prepareText)
	}
	return Object.freeze(lines)
}

function truncateLine(
	line: CanvasTableLine,
	width: number,
	font: string,
	prepareText: CanvasTableTextPreparer,
): CanvasTableLine {
	const ellipsis = '…'
	if (!fitsText(ellipsis, width, font, prepareText)) return Object.freeze({ text: '', width: 0 })
	const graphemes = Array.from(GRAPHEME_SEGMENTER.segment(line.text), ({ segment }) => segment)
	let lower = 0
	let upper = graphemes.length
	while (lower < upper) {
		const count = Math.ceil((lower + upper) / 2)
		const candidate = `${graphemes.slice(0, count).join('')}${ellipsis}`
		if (fitsText(candidate, width, font, prepareText)) lower = count
		else upper = count - 1
	}
	const text = `${graphemes.slice(0, lower).join('')}${ellipsis}`
	const prepared = prepareText({ text, font })
	return Object.freeze({ text, width: measureNaturalWidth(prepared) })
}

function fitsText(
	text: string,
	width: number,
	font: string,
	prepareText: CanvasTableTextPreparer,
): boolean {
	return measureNaturalWidth(prepareText({ text, font })) <= width
}

function resolveTextStyle(
	base: CanvasTableResolvedTextStyle,
	...overrides: readonly CanvasTableTextStyleOverride[]
): CanvasTableResolvedTextStyle {
	let font = base.font
	let lineHeight = base.lineHeight
	let padding = base.padding
	let color = base.color
	let background = base.background
	let textAlign = base.textAlign
	let maxLines = base.maxLines
	let overflow = base.overflow
	for (const override of overrides) {
		if (override.font !== undefined) font = override.font
		if (override.lineHeight !== undefined) lineHeight = override.lineHeight
		if (override.padding !== undefined) padding = override.padding
		if (override.color !== undefined) color = override.color
		if (override.background !== undefined) background = override.background
		if (override.textAlign !== undefined) textAlign = override.textAlign
		if (override.maxLines !== undefined) maxLines = override.maxLines
		if (override.overflow !== undefined) overflow = override.overflow
	}
	return Object.freeze({
		font,
		lineHeight,
		padding,
		color,
		...(background === undefined ? {} : { background }),
		textAlign,
		maxLines,
		overflow,
	})
}

function withBackground(
	style: CanvasTableResolvedTextStyle,
	background: string,
): CanvasTableResolvedTextStyle {
	return Object.freeze({ ...style, background })
}

function drawCellText(context: SKRSContext2D, cell: CanvasTableCellLayout): void {
	if (cell.lines.length === 0) return
	context.save()
	try {
		context.beginPath()
		context.rect(
			cell.contentBounds.x,
			cell.contentBounds.y,
			cell.contentBounds.width,
			cell.contentBounds.height,
		)
		context.clip()
		context.font = cell.style.font
		context.fillStyle = cell.style.color
		context.textBaseline = 'top'
		context.textAlign = cell.style.textAlign
		const x =
			cell.style.textAlign === 'center'
				? cell.contentBounds.x + cell.contentBounds.width / 2
				: cell.style.textAlign === 'right'
					? cell.contentBounds.x + cell.contentBounds.width
					: cell.contentBounds.x
		for (const [lineIndex, line] of cell.lines.entries()) {
			context.fillText(line.text, x, cell.contentBounds.y + lineIndex * cell.style.lineHeight)
		}
	} finally {
		context.restore()
	}
}

function drawGrid(context: SKRSContext2D, table: CanvasTableLayout): void {
	if (table.border.width === 0) return
	context.save()
	try {
		context.strokeStyle = table.border.color
		context.lineWidth = table.border.width
		context.lineCap = 'butt'
		context.beginPath()
		for (const column of table.columns) {
			context.moveTo(column.x, table.bounds.y)
			context.lineTo(column.x, table.bounds.y + table.bounds.height)
		}
		context.moveTo(table.bounds.x + table.bounds.width, table.bounds.y)
		context.lineTo(table.bounds.x + table.bounds.width, table.bounds.y + table.bounds.height)
		for (const row of tableRows(table)) {
			context.moveTo(table.bounds.x, row.bounds.y)
			context.lineTo(table.bounds.x + table.bounds.width, row.bounds.y)
		}
		context.moveTo(table.bounds.x, table.bounds.y + table.bounds.height)
		context.lineTo(table.bounds.x + table.bounds.width, table.bounds.y + table.bounds.height)
		context.stroke()
	} finally {
		context.restore()
	}
}

function* tableRows(
	table: CanvasTableLayout,
): Generator<CanvasTableHeaderRowLayout | CanvasTableBodyRowLayout> {
	if (table.header !== undefined) yield table.header
	yield* table.rows
}

function* tableCells(table: CanvasTableLayout): Generator<CanvasTableCellLayout> {
	for (const row of tableRows(table)) yield* row.cells
}

function freezeLine(line: LayoutLine): CanvasTableLine {
	return Object.freeze({ text: line.text, width: line.width })
}

function freezeBounds(x: number, y: number, width: number, height: number): CanvasTableBounds {
	return Object.freeze({ x, y, width, height })
}

function emptyCell(): NormalizedCell {
	return Object.freeze({ text: '', style: EMPTY_STYLE_OVERRIDE })
}

function normalizeText(value: unknown, label: string): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	throw new TypeError(`${label} text must be a string or finite number`)
}

function readFinite(record: Record<string, unknown>, key: string, fallback: number): number {
	const value = hasOwn(record, key) ? record[key] : undefined
	if (value === undefined) return fallback
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new TypeError(`${key} must be a finite number`)
	}
	return value
}

function readPositive(record: Record<string, unknown>, key: string): number {
	const value = record[key]
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${key} must be a positive finite number`)
	}
	return value
}

function readOptionalPositive(record: Record<string, unknown>, key: string): number | undefined {
	if (!hasOwn(record, key) || record[key] === undefined) return undefined
	return readPositive(record, key)
}

function readOptionalPositiveInteger(
	record: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = readOptionalPositive(record, key)
	if (value !== undefined && !Number.isSafeInteger(value)) {
		throw new TypeError(`${key} must be a positive safe integer`)
	}
	return value
}

function readOptionalNonNegative(record: Record<string, unknown>, key: string): number | undefined {
	if (!hasOwn(record, key) || record[key] === undefined) return undefined
	const value = record[key]
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`${key} must be a non-negative finite number`)
	}
	return value
}

function readOptionalNonEmptyString(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string | undefined {
	if (!hasOwn(record, key) || record[key] === undefined) return undefined
	const value = record[key]
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${label} ${key} must be a non-empty string`)
	}
	return value.trim()
}

function readOptionalColor(record: Record<string, unknown>, key: string): string | undefined {
	return readOptionalNonEmptyString(record, key, 'Table')
}

function readOptionalTextAlign(
	record: Record<string, unknown>,
	key: string,
): CanvasTableTextAlign | undefined {
	if (!hasOwn(record, key) || record[key] === undefined) return undefined
	const value = record[key]
	if (value !== 'left' && value !== 'center' && value !== 'right') {
		throw new TypeError(`${key} must be left, center, or right`)
	}
	return value
}

function readOptionalOverflow(
	record: Record<string, unknown>,
	key: string,
): CanvasTableOverflow | undefined {
	if (!hasOwn(record, key) || record[key] === undefined) return undefined
	const value = record[key]
	if (value !== 'clip' && value !== 'ellipsis') {
		throw new TypeError(`${key} must be clip or ellipsis`)
	}
	return value
}

function assertAllowedKeys(
	record: Record<string, unknown>,
	label: string,
	allowed: ReadonlySet<string>,
): void {
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) throw new TypeError(`${label} does not support ${key}`)
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(record, key)
}
