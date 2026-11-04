import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TypstDocumentPreview, type TypstDocumentPreviewData } from '../src/document/react.js'

vi.mock('../src/source/project-state.js', () => {
	throw new Error('Loaded a source project')
})
vi.mock('../src/source/parse.js', () => {
	throw new Error('Loaded the source parser')
})

const preview: TypstDocumentPreviewData = {
	revision: 3,
	pages: [{ page: 1, width: 600, height: 800, url: '/pages/3/1.png' }],
	points: [],
	targets: [],
	links: [
		{
			page: 1,
			x: 20,
			y: 30,
			width: 40,
			height: 10,
			title: '固定附录',
			target: { kind: 'position', page: 1, x: 200, y: 600 },
		},
		...[
			'https://example.com/',
			'mailto:editor@example.com',
			'tel:+12345',
			'/document-resources/guide',
			'javascript:alert(1)',
			'data:text/html,secret',
		].map((url, index) => ({
			page: 1,
			x: 20,
			y: 50 + index * 15,
			width: 80,
			height: 10,
			title: `链接 ${index}`,
			target: { kind: 'url' as const, url },
		})),
	],
}

describe('source-free document preview', () => {
	it('renders fixed native destinations and opens only supported URL schemes', () => {
		const markup = renderToStaticMarkup(
			createElement(TypstDocumentPreview, {
				preview,
				revision: 3,
				onSelect: () => {},
			}),
		)
		expect(markup).toContain('跳转到固定附录')
		expect(markup).toContain('href="https://example.com/"')
		expect(markup).toContain('href="mailto:editor@example.com"')
		expect(markup).toContain('href="tel:+12345"')
		expect(markup).toContain('href="/document-resources/guide"')
		expect(markup).toContain('rel="noopener noreferrer"')
		expect(markup).not.toContain('javascript:')
		expect(markup).not.toContain('data:text/html')
	})
	it.each([{ revision: 4 }, { revision: 3, pending: true }])(
		'keeps page images visible while disabling stale or pending interaction: %j',
		(props) => {
			const markup = renderToStaticMarkup(
				createElement(TypstDocumentPreview, {
					preview,
					...props,
					onSelect: () => {},
				}),
			)
			expect(markup).toContain('src="/pages/3/1.png"')
			expect(markup).toContain('aria-busy="true"')
			expect(markup).toContain('disabled=""')
			expect(markup).not.toContain('跳转到')
			expect(markup).not.toContain('typst-document-preview-link')
		},
	)
})
