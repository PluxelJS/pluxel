// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Readme } from '../src/ui/marketplace-readme.tsx'

const failedGrammar = vi.hoisted(() =>
	vi.fn(() => {
		throw new Error('local grammar unavailable')
	}),
)
vi.mock('shiki/langs/diff.mjs', failedGrammar)

let container: HTMLDivElement
let root: Root
beforeEach(() => {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	container = document.createElement('div')
	document.body.append(container)
	root = createRoot(container)
})
afterEach(async () => {
	await act(() => root.unmount())
	container.remove()
	vi.unstubAllGlobals()
})

const fence = (language: string, code: string) => ['~~~' + language, code, '~~~'].join('\n')
const readme = (text: string) => <Readme value={{ text, truncated: false }} />

it('preserves fenced source before hydration and adds light and dark colors to real TypeScript tokens', async () => {
	const code =
		"const content = '<img src=x onerror=alert(1)>'\r\n\r\nexport type Name = string // 名称"
	const content = readme(fence('TS', code))
	const ssr = renderToString(content)
	expect(ssr).toContain('pm-code-language')
	expect(ssr).not.toContain('pm-code-token')
	await act(() => root.render(content))
	await act(async () => {
		await vi.dynamicImportSettled()
	})
	const figure = container.querySelector('figure')!
	const tokens = Array.from(figure.querySelectorAll<HTMLElement>('.pm-code-token'))
	expect(figure.querySelector('figcaption')?.textContent).toBe('TS')
	expect(figure.querySelector('code')?.textContent).toBe(code)
	expect(figure.querySelector('img')).toBeNull()
	expect(tokens.some((token) => token.textContent === 'const')).toBe(true)
	for (const theme of ['light', 'dark']) {
		const colors = new Set(
			tokens.map((token) => token.style.getPropertyValue('--pm-code-' + theme)),
		)
		expect(colors.size).toBeGreaterThan(1)
		expect(colors).not.toContain('')
	}
})

it('keeps unknown, unlabelled and unavailable grammars as literal text when replacing a highlighted block', async () => {
	await act(() => root.render(readme(fence('ts', 'const previous = 1'))))
	await act(async () => {
		await vi.dynamicImportSettled()
	})
	expect(container.querySelector('.pm-code-token')).not.toBeNull()
	const code = '<script>source()</script>'
	await act(() =>
		root.render(
			readme([fence('constructor', code), fence('', code), fence('diff', code)].join('\n\n')),
		),
	)
	await act(async () => {
		await vi.dynamicImportSettled()
	})
	expect(failedGrammar).toHaveBeenCalledOnce()
	expect(Array.from(container.querySelectorAll('figcaption'), (item) => item.textContent)).toEqual([
		'constructor',
		'diff',
	])
	expect(Array.from(container.querySelectorAll('pre > code'), (item) => item.textContent)).toEqual([
		code,
		code,
		code,
	])
	expect(container.querySelector('script,.pm-code-token')).toBeNull()
})
