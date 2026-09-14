// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ContentOutline } from '../src/app/plugins/detail/workbench/ContentOutline'
import { PluginWorkbenchAsideProvider } from '../src/app/plugins/detail/workbench/context'
import { PluginWorkbenchTabActivityProvider } from '../src/app/plugins/detail/workbench/tabActivity'
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
	const portal = document.createElement('div')
	document.body.append(container, portal)
	const root = createRoot(container)
	const claim = vi.fn()
	cleanups.push(() => {
		act(() => root.unmount())
		container.remove()
		portal.remove()
	})
	const render = (children: import('react').ReactNode) =>
		act(() =>
			root.render(
				<MantineProvider>
					<PluginWorkbenchAsideProvider
						value={{
							asideAvailable: true,
							assistHost: portal,
							setAssistHost() {},
							assistVisible: true,
							setAssistClaim: claim,
						}}
					>
						{children}
					</PluginWorkbenchAsideProvider>
				</MantineProvider>,
			),
		)
	return { container, portal, render, claim }
}

function Document({ active }: { active: boolean }) {
	const ref = useRef<HTMLDivElement>(null)
	return (
		<PluginWorkbenchTabActivityProvider active={active}>
			<div ref={ref}>
				<ContentOutline hostRef={ref} />
				<h2 id="intro" tabIndex={-1}>
					Getting <em>started</em>
				</h2>
				<h3 id="details" tabIndex={-1}>
					Details
				</h3>
			</div>
		</PluginWorkbenchTabActivityProvider>
	)
}

describe('Workbench document outline', () => {
	it('shows formatted Markdown headings without overflow and withdraws inactive documents', () => {
		const { render, portal, claim, container } = setup()
		render(<Document active />)
		expect(portal.textContent).toContain('Getting started')
		expect(portal.textContent).toContain('Details')
		expect(claim).toHaveBeenLastCalledWith(expect.any(Symbol), true)
		const host = container.querySelector('h2')!.parentElement!
		host.scrollTo = vi.fn()
		act(() => (portal.querySelectorAll('button')[1] as HTMLButtonElement).click())
		expect(host.scrollTo).toHaveBeenCalledOnce()
		expect(document.activeElement?.id).toBe('details')
		render(<Document active={false} />)
		expect(portal.textContent).toBe('')
		expect(claim).toHaveBeenLastCalledWith(expect.any(Symbol), false)
	})

	it('shows configuration anchors when the editor has no scroll overflow', () => {
		const { render, portal, claim } = setup()
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
		expect(portal.textContent).toContain('General')
		expect(claim).toHaveBeenLastCalledWith(expect.any(Symbol), true)
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
