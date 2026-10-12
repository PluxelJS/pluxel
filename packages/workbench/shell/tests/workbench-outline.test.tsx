// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ContentOutline } from '../src/app/plugins/detail/workbench/ContentOutline'
import { FormToc } from '../src/app/plugins/config/components/FormToc'
import { OutlineNavigator } from '../src/app/plugins/detail/workbench/OutlineNavigator'

vi.mock('valibot-form/web', () => ({ useAutoFormCtx: () => ({ sections: [] }) }))

beforeAll(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
	window.matchMedia = vi
		.fn()
		.mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
})
const cleanups: (() => void)[] = []
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup() {
	const container = document.createElement('div')
	document.body.append(container)
	const root = createRoot(container)
	cleanups.push(() => {
		act(() => root.unmount())
		container.remove()
	})
	const render = (children: import('react').ReactNode) =>
		act(() => root.render(<MantineProvider env="test">{children}</MantineProvider>))
	return { container, render }
}

function Document() {
	const ref = useRef<HTMLDivElement>(null)
	return (
		<div ref={ref}>
			<ContentOutline hostRef={ref} />
			<h2 id="intro" tabIndex={-1}>
				Getting <em>started</em>
			</h2>
			<h3 id="details" tabIndex={-1}>
				Details
			</h3>
		</div>
	)
}

describe('Workbench document outline', () => {
	it('shows formatted Markdown headings without overflow and focuses their document anchors', () => {
		const { render, container } = setup()
		render(<Document />)
		expect(container.textContent).toContain('Getting started')
		expect(container.textContent).toContain('Details')
		const host = container.querySelector('h2')!.parentElement!
		host.scrollTo = vi.fn()
		act(() => (container.querySelectorAll('button')[1] as HTMLButtonElement).click())
		expect(host.scrollTo).toHaveBeenCalledOnce()
		expect(document.activeElement?.id).toBe('details')
	})

	it('shows configuration anchors when the editor has no scroll overflow', () => {
		const { render, container } = setup()
		const host = document.createElement('div')
		host.innerHTML =
			'<h2 id="section:general" data-config-anchor data-config-anchor-label="General"></h2>'
		document.body.append(host)
		cleanups.push(() => host.remove())
		expect(host.scrollHeight).toBe(host.clientHeight)
		render(
			<FormToc
				sectionIdPrefix="section:"
				fieldIdPrefix="field:"
				scrollHost={host}
				scrollHostVersion={0}
			/>,
		)
		expect(container.textContent).toContain('General')
	})

	it('selects headings in its own document when another open document has the same Markdown heading ids', async () => {
		const { render, container } = setup()
		render(
			<>
				<Document />
				<Document />
			</>,
		)
		await act(async () => {})
		const headings = container.querySelectorAll<HTMLHeadingElement>('h3#details')
		const firstHost = headings[0]!.parentElement!
		const secondHost = headings[1]!.parentElement!
		firstHost.scrollTo = vi.fn()
		secondHost.scrollTo = vi.fn()
		const secondButton = [...secondHost.querySelectorAll<HTMLButtonElement>('button')].find(
			(button) => button.textContent === 'Details',
		)!
		await act(async () => secondButton.click())
		expect(secondHost.scrollTo).toHaveBeenCalledOnce()
		expect(firstHost.scrollTo).not.toHaveBeenCalled()
		expect(document.activeElement).toBe(headings[1])
	})

	it('keeps configuration outline selection inside the explicit scroll host even when another host has the same anchor id', () => {
		const { render, container } = setup()
		const firstHost = document.createElement('div')
		const secondHost = document.createElement('div')
		for (const [host, label] of [
			[firstHost, 'First General'],
			[secondHost, 'Second General'],
		] as const) {
			host.setAttribute('data-config-scroll-root', '')
			host.innerHTML = `<h2 id="section:general" data-config-anchor data-config-anchor-label="${label}"></h2>`
			host.scrollTo = vi.fn()
			document.body.append(host)
			cleanups.push(() => host.remove())
		}
		render(
			<FormToc
				sectionIdPrefix="section:"
				fieldIdPrefix="field:"
				scrollHost={secondHost}
				scrollHostVersion={0}
			/>,
		)
		expect(container.textContent).toContain('Second General')
		expect(container.textContent).not.toContain('First General')
		act(() => container.querySelector<HTMLButtonElement>('button')!.click())
		expect(secondHost.scrollTo).toHaveBeenCalledOnce()
		expect(firstHost.scrollTo).not.toHaveBeenCalled()
	})

	it('keeps active-heading tracking inside the outline scroll container', () => {
		const { render, container } = setup()
		const anchors = [
			{ id: 'one', label: 'One', depth: 1 },
			{ id: 'two', label: 'Two', depth: 1 },
		]
		const outline = (activeId: string) => (
			<OutlineNavigator
				anchors={anchors}
				activeId={activeId}
				onSelect={() => {}}
				placeholder="Search headings"
				emptyLabel="No headings"
			/>
		)
		render(outline('one'))
		const viewport = container.querySelector<HTMLElement>('[role="navigation"]')!
		const button = container.querySelectorAll('button')[1]!
		const scrollIntoView = vi.fn()
		button.scrollIntoView = scrollIntoView
		vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
			top: 500,
			bottom: 524,
			height: 24,
		} as DOMRect)
		render(outline('two'))
		expect(viewport.scrollTop).toBeGreaterThan(0)
		expect(scrollIntoView).not.toHaveBeenCalled()
		expect(button.getAttribute('aria-current')).toBe('location')
	})
})
