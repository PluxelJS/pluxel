import { getSchema, type JSONContent } from '@tiptap/core'
import { describe, expect, it } from 'vitest'
import {
	createTypstExtensions,
	exportTypstMarkdown,
	generateTypstRegions,
	prepareTypstCandidate,
	validateTypstRegion,
	type TypstEditorConfig,
} from '../src/tiptap/index.js'
import { textStyleDeclarationError } from '../src/tiptap/text-style.js'

const config: TypstEditorConfig = { regions: [{ id: 'body' }], fields: [] }
const styled = (attrs: Record<string, unknown>): JSONContent => ({
	type: 'doc',
	content: [
		{
			type: 'paragraph',
			content: [{ type: 'text', text: 'Styled 文本', marks: [{ type: 'textStyle', attrs }] }],
		},
	],
})

describe('portable native textStyle', () => {
	it('preserves native four-attribute values and quoted single families without normalizing saved JSON', () => {
		const schema = getSchema(createTypstExtensions())
		for (const attrs of [
			{ fontFamily: 'Liberation Serif', fontSize: '18pt', color: '#abc', backgroundColor: '#1234' },
			{
				fontFamily: '"Noto Serif CJK SC"',
				fontSize: '24px',
				color: '#11223344',
				backgroundColor: 'rgba(255, 128, 0, 0.5)',
			},
			{
				fontFamily: "'思源宋体'",
				fontSize: '.5pt',
				color: 'rgb(0, 128, 255)',
				backgroundColor: null,
			},
			{ fontFamily: '"DIN 1451"', fontSize: '18pt', color: null, backgroundColor: null },
		]) {
			const document = styled(attrs)
			const checked = validateTypstRegion({ config, regionId: 'body', document })
			expect(checked.ok).toBe(true)
			if (!checked.ok) throw new Error(JSON.stringify(checked.issues))
			expect(checked.value).toBe(document)
			expect(schema.nodeFromJSON(document).toJSON().content[0].content[0].marks[0].attrs).toEqual(
				attrs,
			)
		}
		expect(Object.keys(schema.marks.textStyle!.spec.attrs!)).toEqual(
			expect.arrayContaining(['fontFamily', 'fontSize', 'color', 'backgroundColor']),
		)
		expect(schema.marks.textStyle!.spec.attrs).not.toHaveProperty('lineHeight')
	})

	it('rejects invalid raw values and unsupported attributes before the schema can discard them', () => {
		const invalid: Record<string, unknown[]> = {
			fontFamily: [
				'',
				'Arial, serif',
				'Arial; color: red',
				'"Arial',
				'A\\rial',
				'A\nB',
				' inherit',
				'inherit',
				'123',
				'DIN 1451',
			],
			fontSize: [
				'0pt',
				'-1pt',
				'12em',
				'100%',
				'calc(12pt)',
				'1e2pt',
				'12',
				12,
				'1' + '0'.repeat(309) + 'pt',
			],
			color: [
				'red',
				'currentColor',
				'var(--color)',
				'#12',
				'#gggggg',
				'rgb(256, 0, 0)',
				'rgba(0, 0, 0, 2)',
				'rgba(0, 0, 0, -1)',
				'rgb(0, 0, 0, 0.5)',
				'rgba(0, 0, 0)',
				'rgb(1%, 0%, 0%)',
			],
			backgroundColor: ['transparent', 'url(secret)', 42, {}, 'rgba(0, 0, 0, NaN)'],
		}
		for (const [attribute, values] of Object.entries(invalid))
			for (const value of values) {
				const document = styled({ [attribute]: value })
				const original = structuredClone(document)
				expect(validateTypstRegion({ config, regionId: 'body', document })).toMatchObject({
					ok: false,
					issues: expect.arrayContaining([
						expect.objectContaining({
							code: 'INVALID_ATTRIBUTE',
							path: ['content', 0, 'content', 0, 'marks', 0, 'attrs', attribute],
						}),
					]),
				})
				expect(document).toEqual(original)
			}
		expect(
			validateTypstRegion({ config, regionId: 'body', document: styled({ lineHeight: '2' }) }),
		).toMatchObject({
			ok: false,
			issues: expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_ATTRIBUTE' })]),
		})
	})

	it('enforces the same region mark allowlist for all style attributes', () => {
		expect(
			validateTypstRegion({
				config: { ...config, regions: [{ id: 'body', marks: ['bold'] }] },
				regionId: 'body',
				document: styled({ color: '#123456' }),
			}),
		).toMatchObject({ ok: false, issues: [{ code: 'REGION_RULE' }] })
	})

	it('checks raw HTML declarations including ones the browser would ignore or overwrite', () => {
		expect(
			textStyleDeclarationError(
				'font-family: "Liberation Serif"; font-size: 24px; color: rgb(1, 2, 3); background-color: #ffff0080;',
			),
		).toBeUndefined()
		for (const style of [
			'line-height: 2',
			'font-size: 12em',
			'font-size: 0pt',
			'font-weight: bold',
			'color: red',
			'color: #123456; COLOR: #654321',
			'background: #ffff00',
			'font-family: Arial, serif',
			'font-size: 12pt !important',
			'color',
			'constructor: #fff',
			'__proto__: #fff',
		])
			expect(textStyleDeclarationError(style)).toBeTypeOf('string')
	})

	it('maps px to points, safely quotes font names and preserves RGBA alpha in Typst', () => {
		const document = styled({
			fontFamily: '"Liberation Serif"',
			fontSize: '24px',
			color: '#e12',
			backgroundColor: 'rgba(255, 255, 0, 0.5)',
		})
		document.content![0]!.content![0]!.marks!.push({ type: 'bold' }, { type: 'underline' })
		const generated = generateTypstRegions({
			config,
			regions: { body: document },
			data: {},
			snapshotRevision: 1,
		})
		if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
		const source = generated.value.templateFiles['_editor/regions/body.typ']!
		expect(source).toContain('font: "Liberation Serif", size: 18pt, fill: rgb(238, 17, 34, 100%)')
		expect(source).toContain('#highlight(fill: rgb(255, 255, 0, 50%))')
		expect(source).toContain('#strong[')
		expect(source).toContain('#underline[')
		expect(source).toContain('#text("Styled 文本")')
		expect(document.content![0]!.content![0]!.marks![0]!.attrs!.fontSize).toBe('24px')
	})

	it('styles a live dataField binding without serializing a frozen value', () => {
		const document = styled({ fontSize: '18pt', color: '#1234' })
		document.content![0]!.content![0] = {
			type: 'dataField',
			attrs: { path: ['customer', 'name'] },
			marks: document.content![0]!.content![0]!.marks,
		}
		const generated = generateTypstRegions({
			config: { ...config, fields: [{ path: ['customer', 'name'], label: 'Customer' }] },
			regions: { body: document },
			data: { customer: { name: 'Acme' } },
			snapshotRevision: 1,
		})
		if (!generated.ok) throw new Error(JSON.stringify(generated.issues))
		const source = generated.value.templateFiles['_editor/regions/body.typ']!
		expect(source).toContain('#text(size: 18pt, fill: rgb(17, 34, 51,')
		expect(source).not.toContain('Acme')
		expect(JSON.parse(generated.value.inputFiles['/inputs/editor/data.json']!)).toEqual({
			customer: { name: 'Acme' },
		})
		const updated = generateTypstRegions({
			config: { ...config, fields: [{ path: ['customer', 'name'], label: 'Customer' }] },
			regions: { body: document },
			data: { customer: { name: 'Updated customer' } },
			snapshotRevision: 2,
		})
		if (!updated.ok) throw new Error(JSON.stringify(updated.issues))
		expect(updated.value.templateFiles).toEqual(generated.value.templateFiles)
		expect(JSON.parse(updated.value.inputFiles['/inputs/editor/data.json']!)).toEqual({
			customer: { name: 'Updated customer' },
		})
	})

	it('reports each style as Markdown loss and blocks whole-region candidate replacement', () => {
		for (const attrs of [
			{ fontFamily: 'Liberation Serif' },
			{ fontSize: '18pt' },
			{ color: '#dc2626' },
			{ backgroundColor: '#fef08a' },
		]) {
			const document = styled(attrs)
			const exported = exportTypstMarkdown({ config, regionId: 'body', document })
			expect(exported).toMatchObject({
				ok: true,
				value: {
					lossless: false,
					issues: expect.arrayContaining([
						expect.objectContaining({
							code: 'COMPLEX_CONTENT',
							path: ['content', 0, 'content', 0, 'marks', 0],
						}),
					]),
				},
			})
			expect(
				prepareTypstCandidate({
					config,
					document,
					currentRevision: 1,
					canEdit: () => true,
					candidate: { regionId: 'body', baseRevision: 1, markdown: 'New plain content' },
				}),
			).toMatchObject({
				ok: false,
				issues: expect.arrayContaining([expect.objectContaining({ code: 'COMPLEX_CONTENT' })]),
			})
			expect(document).toEqual(styled(attrs))
		}
	})
})
