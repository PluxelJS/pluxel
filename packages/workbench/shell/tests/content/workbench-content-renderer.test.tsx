// @vitest-environment jsdom

import type { WorkbenchContentPlan } from '@pluxel/workbench/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { WorkbenchContentRenderer } from '../../src/app/workbench/WorkbenchContentRenderer'

const heading = 'Redis <script>Markup stays text</script>'
const plan = {
	version: 1,
	kind: 'workbench-content',
	document: {
		version: 1,
		blocks: [
			{
				type: 'heading',
				level: 1,
				anchor: 'guide',
				children: [{ type: 'text', value: heading }],
			},
			{
				type: 'paragraph',
				children: [
					{
						type: 'link',
						target: { kind: 'fragment', anchor: 'guide' },
						children: [{ type: 'text', value: 'Top' }],
					},
					{
						type: 'link',
						target: { kind: 'https', href: 'https://example.com/docs' },
						children: [{ type: 'text', value: 'Docs' }],
					},
				],
			},
		],
	},
	slots: [],
} satisfies WorkbenchContentPlan

it('escapes source text and keeps fragment links scoped to each open Content', () => {
	const container = document.createElement('div')
	container.innerHTML = renderToStaticMarkup(
		<>
			<WorkbenchContentRenderer plan={plan} />
			<WorkbenchContentRenderer plan={plan} />
		</>,
	)

	const headings = [...container.querySelectorAll('h1')]
	expect(headings.map((element) => element.textContent)).toEqual([heading, heading])
	expect(container.querySelector('script')).toBeNull()
	const anchors = headings.map((element) => element.id)
	expect(new Set(anchors).size).toBe(2)
	expect(
		[...container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].map((link) => link.hash),
	).toEqual(anchors.map((anchor) => '#' + anchor))
	for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href^="https:"]')) {
		expect(link.target).toBe('_blank')
		expect([...link.relList]).toEqual(expect.arrayContaining(['noopener', 'noreferrer']))
	}
	expect(container.querySelectorAll('a[href^="https:"]')).toHaveLength(2)
})
