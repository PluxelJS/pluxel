// @vitest-environment jsdom

import type { WorkbenchStandardPagePlanV1 } from '@pluxel/runtime/workbench/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StandardPageRenderer } from '../src/app/workbench/StandardPageRenderer'

const plan = {
	version: 1,
	kind: 'standard-page',
	document: {
		version: 1,
		blocks: [
			{
				type: 'heading',
				level: 1,
				anchor: 'redis-guide',
				children: [{ type: 'text', value: 'Redis <script>alert(1)</script>' }],
			},
			{
				type: 'paragraph',
				children: [
					{ type: 'text', value: 'Use ' },
					{ type: 'strong', children: [{ type: 'text', value: 'saved' }] },
					{ type: 'text', value: ' configuration with ' },
					{ type: 'code', value: '<endpoint>' },
					{ type: 'text', value: '.' },
				],
			},
			{
				type: 'blockquote',
				children: [
					{
						type: 'paragraph',
						children: [{ type: 'emphasis', children: [{ type: 'text', value: 'Restart first.' }] }],
					},
				],
			},
			{
				type: 'list',
				ordered: true,
				start: 2,
				items: [
					{
						children: [
							{
								type: 'paragraph',
								children: [
									{
										type: 'delete',
										children: [{ type: 'text', value: 'old endpoint' }],
									},
								],
							},
						],
					},
				],
			},
			{ type: 'thematic-break' },
			{ type: 'code', language: 'sh', value: '</code><script>unsafe()</script>' },
			{
				type: 'table',
				align: ['left', 'right'],
				header: [[{ type: 'text', value: 'Key' }], [{ type: 'text', value: 'Value' }]],
				rows: [[[{ type: 'text', value: 'status' }], [{ type: 'text', value: 'ready' }]]],
			},
			{
				type: 'paragraph',
				children: [
					{
						type: 'link',
						target: { kind: 'https', href: 'https://example.com/docs' },
						children: [{ type: 'text', value: 'Docs' }],
					},
					{ type: 'text', value: ' · ' },
					{
						type: 'link',
						target: { kind: 'mailto', href: 'mailto:ops@example.com' },
						children: [{ type: 'text', value: 'Mail' }],
					},
					{ type: 'text', value: ' · ' },
					{
						type: 'link',
						target: { kind: 'fragment', anchor: 'redis-guide' },
						children: [{ type: 'text', value: 'Top' }],
					},
				],
			},
		],
	},
} satisfies WorkbenchStandardPagePlanV1

describe('Standard Page renderer', () => {
	it('renders the portable plan as semantic HTML and escapes all source text', () => {
		const container = document.createElement('div')
		container.innerHTML = renderToStaticMarkup(<StandardPageRenderer plan={plan} />)

		expect(container.querySelector('article')).not.toBeNull()
		expect(container.querySelector('h1')?.textContent).toBe('Redis <script>alert(1)</script>')
		expect(container.querySelector('h1 script')).toBeNull()
		expect(container.querySelector('strong')?.textContent).toBe('saved')
		expect(container.querySelector('blockquote em')?.textContent).toBe('Restart first.')
		expect(container.querySelector('ol')?.start).toBe(2)
		expect(container.querySelector('del')?.textContent).toBe('old endpoint')
		expect(container.querySelector('pre code')?.textContent).toBe(
			'</code><script>unsafe()</script>',
		)
		expect(container.querySelector('pre script')).toBeNull()
		expect(container.querySelectorAll('thead th')).toHaveLength(2)
		expect(container.querySelector('tbody td[data-align="right"]')?.textContent).toBe('ready')
		expect(container.querySelector('img')).toBeNull()
	})

	it('uses closed link policies and scopes fragments to each mounted page', () => {
		const container = document.createElement('div')
		container.innerHTML = renderToStaticMarkup(
			<>
				<StandardPageRenderer plan={plan} />
				<StandardPageRenderer plan={plan} />
			</>,
		)

		const documents = [...container.querySelectorAll('article')]
		expect(documents).toHaveLength(2)
		const firstHeading = documents[0]!.querySelector('h1')!
		const secondHeading = documents[1]!.querySelector('h1')!
		expect(firstHeading.id).not.toBe(secondHeading.id)
		expect(documents[0]!.querySelector('a[href^="#"]')?.getAttribute('href')).toBe(
			`#${firstHeading.id}`,
		)
		expect(documents[1]!.querySelector('a[href^="#"]')?.getAttribute('href')).toBe(
			`#${secondHeading.id}`,
		)

		const https = documents[0]!.querySelector('a[href="https://example.com/docs"]')!
		expect(https.getAttribute('target')).toBe('_blank')
		expect(https.getAttribute('rel')?.split(' ').sort()).toEqual(['noopener', 'noreferrer'])
		const mail = documents[0]!.querySelector('a[href="mailto:ops@example.com"]')!
		expect(mail.getAttribute('target')).toBeNull()
	})
})
