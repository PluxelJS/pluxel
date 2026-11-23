// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
	Marketplace,
	PackageMarketClient,
	type MarketplaceData,
	type MarketplaceRead,
	type MarketPackageSummary,
	type MarketRelease,
} from '@pluxel/plugin-package-manager/marketplace'

// The browser entry must render without either host UI framework or its transport.
vi.mock('@mantine/core', () => {
	throw new Error('Portable marketplace imported Mantine')
})
vi.mock('@pluxel/workbench/react', () => {
	throw new Error('Portable marketplace imported Workbench')
})
vi.mock('capnweb', () => {
	throw new Error('Portable marketplace imported CapnWeb')
})

let root: Root
let container: HTMLDivElement
const pkg: MarketPackageSummary = {
	registry: 'https://registry.npmjs.org',
	name: '@example/plugin',
	description: 'A useful plugin',
	latest: '1.0.0',
	repository: 'https://github.com/example/plugin',
	repositoryStars: 0,
	repositoryObservedAt: 1,
	author: null,
	indexedVersions: 1,
	observedAt: 1,
	official: true,
	category: 'tools',
	tags: ['test', 'tooling', 'integration'],
}
const release: MarketRelease = {
	registry: pkg.registry,
	name: pkg.name,
	version: '1.0.0',
	integrity: 'sha512-checked',
	checkedAt: 1,
	provenance: { status: 'missing' },
	peerDependencies: {},
	pluginPackages: {},
	readme: { text: '<img src=x onerror=alert(1)>', truncated: false },
	license: 'MIT',
}
function read<T>(value: T): MarketplaceRead<T> {
	return { data: { ok: true, value }, isFetching: false, refetch: async () => {} }
}
const data: MarketplaceData = {
	Facets({ children }: ComponentProps<MarketplaceData['Facets']>) {
		return children(read({ total: 1, authors: [], categories: [], registries: [], tags: [] }))
	},
	Packages({ children }: ComponentProps<MarketplaceData['Packages']>) {
		return children(read({ packages: [pkg], nextCursor: null }))
	},
	Package({ children }: ComponentProps<MarketplaceData['Package']>) {
		return children(
			read({
				...pkg,
				distTags: { latest: '1.0.0' },
				metadataVersion: '1.0.0',
				readme: { text: 'Registry README', truncated: false },
				license: 'MIT',
				coverage: 'indexed-only' as const,
			}),
		)
	},
	Releases({ children }: ComponentProps<MarketplaceData['Releases']>) {
		return children(
			read({
				releases: [{ version: release.version, integrity: release.integrity, checkedAt: 1 }],
				nextCursor: null,
				coverage: 'indexed-only' as const,
			}),
		)
	},
	Release({ children }: ComponentProps<MarketplaceData['Release']>) {
		return children(read(release))
	},
}
const documentation: MarketplaceData = {
	...data,
	Release({ children }: ComponentProps<MarketplaceData['Release']>) {
		return children(
			read({
				...release,
				readme: {
					text: [
						'# Package guide',
						'',
						'A **useful** plugin with `inline code`.',
						'',
						'## Install',
						'',
						'- Read the [documentation](https://example.com/docs).',
						'- [Reference guide][guide]',
						'- [x] Checked release',
						'',
						'```sh',
						'pnpm add @example/plugin',
						'```',
						'',
						'| Option | Default |',
						'| :--- | ---: |',
						'| retries | 3 |',
						'',
						'[guide]: https://example.com/guide',
						'',
						'[relative](./admin) [root](/admin) [protocol](//evil.example)',
						'[run](java&#x73;cript:alert%281%29) [data](data:text/html;base64,PHNjcmlwdD4=)',
						'',
						'![remote badge](https://evil.example/tracker.svg)',
						'',
						'<img src=x onerror=alert(1)>',
						'<script>alert(1)</script>',
						'<iframe src="https://evil.example"></iframe>',
					].join('\n'),
					truncated: true,
				},
			}),
		)
	},
}

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
async function click(label: string) {
	const button = [...container.querySelectorAll('button')].find(
		(item) => item.textContent === label,
	)!
	expect(button).toBeDefined()
	await act(() => button.click())
}
async function openRelease() {
	await click(pkg.name)
	expect(container.querySelector<HTMLElement>('.pm-catalog')?.hidden).toBe(true)
	await click('Versions')
	const select = container.querySelector('select')!
	await act(() => {
		select.value = '1.0.0'
		select.dispatchEvent(new Event('change', { bubbles: true }))
	})
}

it('renders through its public browser entry without a Provider or install capability', async () => {
	expect(PackageMarketClient).toBeTypeOf('function')
	await act(() => root.render(createElement(Marketplace, { data })))
	const card = container.querySelector('ul[aria-label="Plugin catalog"] > li')
	expect(card?.textContent).toContain(pkg.description)
	expect(card?.textContent).toContain('#test')
	expect(card?.textContent).toContain('#tooling')
	expect(card?.querySelector('[title="integration"]')?.textContent).toContain('+1')
	expect(card?.querySelector('a[href="https://github.com/example/plugin"]')?.textContent).toBe(
		'example/plugin',
	)
	expect(card?.querySelector('[aria-label="0 repository stars"]')).not.toBeNull()
	expect(card?.querySelector('.pm-package-status')).toBeNull()
	expect(card?.textContent).toContain('Repository owner unavailable')
	expect(container.querySelector('aside[aria-label="Catalog filters"]')).not.toBeNull()
	await openRelease()
	expect(container.querySelector('option[value="1.0.0"]')?.textContent).toBe(
		'1.0.0 (registry latest)',
	)
	expect(
		container.querySelector('.pm-detail-header [aria-label="0 repository stars"]'),
	).not.toBeNull()
	expect(container.querySelector('.pm-detail-header')?.textContent).toContain('#integration')
	expect(container.querySelector('img')).toBeNull()
	expect(container.querySelector('.pm-readme')!.textContent).toBe('<img src=x onerror=alert(1)>')
	expect(
		[...container.querySelectorAll('button')].some(
			(item) => item.textContent === 'Choose this release',
		),
	).toBe(false)
})

it('renders readable Markdown while preventing package HTML and unsafe or relative navigation', async () => {
	await act(() => root.render(createElement(Marketplace, { data: documentation })))
	await openRelease()
	const readme = container.querySelector('.pm-readme')!
	expect(readme.querySelector('h1')!.textContent).toBe('Package guide')
	expect(readme.querySelector('h2')!.textContent).toBe('Install')
	expect(readme.querySelector('strong')!.textContent).toBe('useful')
	expect(readme.querySelector('li')!.textContent).toBe('Read the documentation.')
	expect(readme.querySelector('pre code')!.textContent).toBe('pnpm add @example/plugin')
	expect(readme.querySelector('th[scope="col"]')!.textContent).toBe('Option')
	expect(readme.querySelector('tbody td')!.textContent).toBe('retries')
	expect(readme.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
	expect([...readme.querySelectorAll('a')].map((item) => item.href)).toEqual([
		'https://example.com/docs',
		'https://example.com/guide',
	])
	expect(readme.querySelector('img, script, iframe')).toBeNull()
	expect(readme.textContent).toContain('<img src=x onerror=alert(1)>')
	expect(readme.textContent).toContain('<script>alert(1)</script>')
	expect(readme.textContent).toContain('relative root protocol')
	expect(readme.textContent).toContain('run data')
	expect(container.textContent).toContain('This README was truncated by the market.')
})

it('composes host actions with the checked release currently displayed', async () => {
	const choose = vi.fn()
	const releaseAction = (checked: MarketRelease) =>
		createElement(
			'button',
			{ type: 'button', onClick: () => choose(checked) },
			'Choose this release',
		)
	await act(() =>
		root.render(createElement(Marketplace, { data, releaseAction, colorScheme: 'dark' })),
	)
	expect(choose).not.toHaveBeenCalled()
	const entry = container.querySelector<HTMLButtonElement>('.pm-package-name')!
	container.style.overflowY = 'auto'
	container.scrollTop = 50
	await click(pkg.name)
	expect(document.activeElement?.textContent?.trim()).toBe('Back to packages')
	expect(
		[...container.querySelectorAll('button')].some(
			(item) => item.textContent === 'Choose this release',
		),
	).toBe(false)
	await click('Back to packages')
	expect(document.activeElement).toBe(entry)
	expect(container.scrollTop).toBe(50)
	await openRelease()
	await click('Choose this release')
	expect(choose).toHaveBeenCalledExactlyOnceWith(release)
})
