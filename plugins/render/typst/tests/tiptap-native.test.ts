import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { getSchema, Node, type JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { CellSelection, mergeCells, TableMap } from '@tiptap/pm/tables'
import { expect, it } from 'vitest'
import {
	generateTypstRegions,
	createTypstExtensions,
	fieldDisplay,
	findTypstRegionPosition,
	findTypstGeneratedPosition,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'
import runTypst, { renderTypstPage } from '../src/worker.ts'
import { pointAtSource } from '../src/browser/navigation.js'

it('compiles real generated fields, tables, resources, styled Marks and an external node into PDF/vector/PNG with navigation', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-editor-native-'))
	try {
		const Notice = Node.create({
			name: 'notice',
			group: 'block',
			content: 'block+',
			addAttributes: () => ({ tone: { default: 'note' } }),
		})
		const config: TypstEditorConfig = {
			regions: [{ id: 'body' }, { id: 'conclusion' }],
			fields: [{ path: ['customer', 'name'], label: 'Customer' }],
			extensions: [Notice],
			nodeMappings: {
				notice: {
					validateAttributes: (attrs) => attrs.tone === 'note',
					serialize: (node, context) =>
						`#block(fill: rgb("eff6ff"), inset: 8pt)[${context.children(node)}]\n`,
				},
			},
			resolveImage: (id) =>
				id === 'company-logo' ? { path: '/inputs/assets/logo.svg' } : undefined,
		}
		const paragraph = (...content: JSONContent[]): JSONContent => ({ type: 'paragraph', content })
		const text = (value: string): JSONContent => ({ type: 'text', text: value })
		const field: JSONContent = {
			type: 'dataField',
			attrs: { path: ['customer', 'name'] },
			marks: [
				{
					type: 'textStyle',
					attrs: {
						fontFamily: 'Liberation Serif',
						fontSize: '12pt',
						color: '#012f',
						backgroundColor: 'rgba(0, 128, 255, 0.5)',
					},
				},
			],
		}
		const combinedMarks = [
			{ type: 'link', attrs: { href: 'https://example.com/a?q=%23' } },
			{ type: 'underline' },
			{ type: 'italic' },
			{ type: 'bold' },
			{ type: 'strike' },
			{
				type: 'textStyle',
				attrs: {
					fontFamily: 'Liberation Serif',
					fontSize: '24px',
					color: '#dc2626',
					backgroundColor: '#ffff00',
				},
			},
		]
		const regions: Record<string, JSONContent> = {
			body: {
				type: 'doc',
				content: [
					{ type: 'heading', attrs: { level: 1 }, content: [text('Report A😀B')] },
					paragraph(text('Customer: '), field),
					paragraph({
						type: 'text',
						text: 'Quotes " \\ # [ ] ( ) | $ * _ < >\nUnicode 😀  双空格\tTab',
						marks: combinedMarks,
					}),
					{
						type: 'codeBlock',
						attrs: { language: 'typst' },
						content: [text('#eval("must remain literal")\nline two')],
					},
					{
						type: 'table',
						content: [
							{
								type: 'tableRow',
								content: [
									{
										type: 'tableHeader',
										attrs: { colspan: 2, colwidth: [120, 240] },
										content: [paragraph(text('Combined header'))],
									},
								],
							},
							{
								type: 'tableRow',
								content: [
									{
										type: 'tableCell',
										attrs: { rowspan: 2, colwidth: [120] },
										content: [
											paragraph(text('First | paragraph')),
											paragraph(text('Customer '), field),
										],
									},
									{
										type: 'tableCell',
										attrs: { colwidth: [240], align: 'right' },
										content: [paragraph(text('42'))],
									},
								],
							},
							{
								type: 'tableRow',
								content: [
									{
										type: 'tableCell',
										attrs: { colwidth: [240] },
										content: [paragraph(text('Second row'))],
									},
								],
							},
						],
					},
					{ type: 'image', attrs: { src: 'company-logo', alt: 'Company logo', width: 24 } },
				],
			},
			conclusion: {
				type: 'doc',
				content: [
					{
						type: 'notice',
						attrs: { tone: 'note' },
						content: [paragraph(text('External editable notice'))],
					},
				],
			},
		}
		const result = generateTypstRegions({
			regions,
			config,
			data: { customer: { name: 'Acme😀' } },
			snapshotRevision: 'native-1',
		})
		if (!result.ok) throw new Error(JSON.stringify(result.issues))
		for (const [path, source] of Object.entries({
			...result.value.templateFiles,
			...Object.fromEntries(
				Object.entries(result.value.inputFiles).map(([inputPath, value]) => [
					inputPath.replace(/^\//, ''),
					value,
				]),
			),
		})) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), source)
		}
		await mkdir(join(root, 'inputs/assets'), { recursive: true })
		await writeFile(
			join(root, 'inputs/assets/logo.svg'),
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>',
		)
		await writeFile(
			join(root, 'main.typ'),
			'#set page(width: 180mm, height: 240mm)\nFixed template\n#include "_editor/regions/body.typ"\n#include "_editor/regions/conclusion.typ"',
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
		expect(Buffer.from(compiled.pdf).toString('latin1')).toContain('LiberationSerif')
		expect(compiled.vector.byteLength).toBeGreaterThan(100)
		const image = renderTypstPage({
			kind: 'render',
			revision: 1,
			page: 1,
			scale: 1,
			maxOutputBytes: 8_000_000,
		})
		const pixels = pngPixels(image.data)
		let redPixels = 0
		let yellowPixels = 0
		for (let offset = 0; offset < pixels.length; offset += 4) {
			if (pixels[offset] === 220 && pixels[offset + 1] === 38 && pixels[offset + 2] === 38)
				redPixels++
			if (pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 0)
				yellowPixels++
		}
		expect(redPixels).toBeGreaterThan(20)
		expect(yellowPixels).toBeGreaterThan(100)
		expect(compiled.navigation.outline).toContainEqual(
			expect.objectContaining({ title: 'Report A😀B' }),
		)
		const generatedHit = compiled.navigation.points.find(
			(point) => point.path === '_editor/regions/body.typ',
		)
		expect(generatedHit).toBeDefined()
		const headingSource = findTypstGeneratedPosition({
			mapping: result.value.mapping,
			navigation: compiled.navigation,
			regionId: 'body',
			position: 1,
			snapshotRevision: 'native-1',
		})
		expect(headingSource).toBeDefined()
		const headingRange = result.value.mapping.find((item) => item.regionId === 'body')!.range
		expect(headingSource!.line).toBe(headingRange.start.line)
		expect(headingSource!.column).toBeGreaterThan(headingRange.start.column)
		expect(pointAtSource(compiled.navigation.points, headingSource!, 1)).toBeDefined()
		expect(
			findTypstRegionPosition({
				mapping: result.value.mapping,
				position: headingSource!,
				snapshotRevision: 'native-1',
			}),
		).toMatchObject({ regionId: 'body', from: 1 })
		expect(
			findTypstRegionPosition({
				mapping: result.value.mapping,
				position: generatedHit!,
				snapshotRevision: 'native-1',
			}),
		).toMatchObject({ regionId: 'body' })
		expect(
			compiled.navigation.points.some((point) => point.path === '_editor/regions/conclusion.typ'),
		).toBe(true)
		const reverseMarks = structuredClone(regions)
		reverseMarks.body!.content![2]!.content![0]!.marks!.reverse()
		const reordered = generateTypstRegions({
			regions: reverseMarks,
			config,
			data: { customer: { name: 'Acme😀' } },
			snapshotRevision: 'native-2',
		})
		expect(reordered.ok).toBe(true)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('resolves array indices and numeric object keys after data-only updates to the same generated template', async () => {
	const root = await mkdtemp(join(tmpdir(), 'typst-editor-array-fields-'))
	try {
		const config: TypstEditorConfig = {
			regions: [{ id: 'body' }],
			fields: [
				{ path: ['items', '0', 'name'], label: 'Item' },
				{ path: ['dictionary', '01'], label: 'Numeric object key' },
				{ path: ['items', 'length'], label: 'Length' },
			],
		}
		const updates = [
			{ items: [{ name: 'Array item' }], dictionary: { '01': 'Leading zero' } },
			{ items: { '0': { name: 'Object item' }, length: 9 }, dictionary: { '01': 'Still a key' } },
		]
		const generated = generateTypstRegions({
			config,
			regions: {
				body: {
					type: 'doc',
					content: [
						{
							type: 'heading',
							attrs: { level: 1 },
							content: config.fields.flatMap((field, index) => [
								...(index ? [{ type: 'text', text: ' / ' }] : []),
								{ type: 'dataField', attrs: { path: field.path } },
							]),
						},
					],
				},
			},
			data: updates[0],
			snapshotRevision: 1,
		})
		if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
		for (const [path, source] of Object.entries(generated.value.templateFiles)) {
			await mkdir(dirname(join(root, path)), { recursive: true })
			await writeFile(join(root, path), source)
		}
		await mkdir(join(root, 'inputs/editor'), { recursive: true })
		await writeFile(join(root, 'main.typ'), '#include "_editor/regions/body.typ"')
		for (const [index, data] of updates.entries()) {
			await writeFile(join(root, 'inputs/editor/data.json'), JSON.stringify(data))
			const compiled = runTypst({
				revision: index + 1,
				root,
				entry: 'main.typ',
				maxOutputBytes: 8_000_000,
				bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
			})
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
			expect(compiled.navigation.outline[0]?.title).toBe(
				config.fields.map((field) => fieldDisplay(data, field)).join(' / '),
			)
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it.each(['tableCell', 'tableHeader'])(
	'compiles a native merge into a %s row without promoting body cells to repeating headers',
	async (secondRowType) => {
		const root = await mkdtemp(join(tmpdir(), 'typst-editor-header-merge-'))
		try {
			const config: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
			const schema = getSchema(createTypstExtensions())
			const paragraph = (text: string): JSONContent => ({
				type: 'paragraph',
				content: [{ type: 'text', text }],
			})
			const document = schema.nodeFromJSON({
				type: 'doc',
				content: [
					{
						type: 'table',
						content: ['tableHeader', secondRowType].map((type, row) => ({
							type: 'tableRow',
							content: [0, 1].map((column) => ({
								type,
								content: [paragraph(`Cell ${row},${column}`)],
							})),
						})),
					},
				],
			})
			const map = TableMap.get(document.firstChild!)
			let state = EditorState.create({
				doc: document,
				selection: CellSelection.create(document, 1 + map.map[0]!, 1 + map.map[2]!),
			})
			expect(
				mergeCells(state, (transaction) => {
					state = state.apply(transaction)
				}),
			).toBe(true)
			const generated = generateTypstRegions({
				config,
				regions: { body: state.doc.toJSON() },
				data: {},
				snapshotRevision: 1,
			})
			if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
			const source = generated.value.templateFiles['_editor/regions/body.typ']!
			expect(source.includes('table.header(')).toBe(secondRowType === 'tableHeader')
			expect(source).toContain('rowspan: 2')
			expect(source).toContain('#strong[')
			await mkdir(join(root, '_editor/regions'), { recursive: true })
			await mkdir(join(root, 'inputs/editor'), { recursive: true })
			await writeFile(join(root, '_editor/regions/body.typ'), source)
			await writeFile(join(root, 'inputs/editor/data.json'), '{}')
			await writeFile(join(root, 'main.typ'), '#include "_editor/regions/body.typ"')
			const compiled = runTypst({
				revision: 1,
				root,
				entry: 'main.typ',
				maxOutputBytes: 8_000_000,
				bindingPath: fileURLToPath(new URL('../native/compiler.node', import.meta.url)),
			})
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
			expect(Buffer.from(compiled.pdf).subarray(0, 5).toString()).toBe('%PDF-')
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	},
)

/** Decode RGBA8 output to verify rendered colors rather than only the PNG signature. */
function pngPixels(bytes: Uint8Array): Buffer {
	const data = Buffer.from(bytes)
	expect(data.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
	expect(data[24]).toBe(8)
	expect(data[25]).toBe(6)
	const width = data.readUInt32BE(16)
	const height = data.readUInt32BE(20)
	const chunks: Buffer[] = []
	for (let offset = 8; offset < data.length;) {
		const length = data.readUInt32BE(offset)
		if (data.toString('ascii', offset + 4, offset + 8) === 'IDAT')
			chunks.push(data.subarray(offset + 8, offset + 8 + length))
		offset += length + 12
	}
	const raw = inflateSync(Buffer.concat(chunks))
	const pixels = Buffer.alloc(width * height * 4)
	const stride = width * 4
	for (let row = 0; row < height; row++) {
		const filter = raw[row * (stride + 1)]!
		for (let x = 0; x < stride; x++) {
			const index = row * stride + x
			const a = x >= 4 ? pixels[index - 4]! : 0
			const b = row ? pixels[index - stride]! : 0
			const c = row && x >= 4 ? pixels[index - stride - 4]! : 0
			const p = a + b - c
			const pa = Math.abs(p - a)
			const pb = Math.abs(p - b)
			const pc = Math.abs(p - c)
			const predictor = [
				0,
				a,
				b,
				Math.floor((a + b) / 2),
				pa <= pb && pa <= pc ? a : pb <= pc ? b : c,
			][filter]
			if (predictor === undefined) throw new Error('Unsupported PNG filter')
			pixels[index] = (raw[row * (stride + 1) + x + 1]! + predictor) & 255
		}
	}
	return pixels
}
