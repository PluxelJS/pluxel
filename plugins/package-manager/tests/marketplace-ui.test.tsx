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
				distTags: { latest: '1.0.0', next: '2.0.0-beta.1' },
				metadataVersion: '1.0.0',
				checkedRequirements: {
					version: release.version,
					peerDependencies: { '@pluxel/core': '^1', 'http-plugin': '^2', 'log-plugin': '^3' },
					pluginPackages: { 'http-plugin': 'required' as const, 'log-plugin': 'optional' as const },
				},
				readme: { text: '## Usage\n\n## **Usage**', truncated: false },
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
	const row = container.querySelector<HTMLButtonElement>('.pm-release-row')!
	expect(row.textContent).toContain('1.0.0')
	expect(row.textContent).toContain('latest')
	expect(row.querySelector('time')?.dateTime).toBeTruthy()
	await act(() => row.click())
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
	expect(
		container.querySelector('.pm-release-row[aria-expanded="true"] .pm-badge')?.textContent,
	).toBe('latest')
	expect(
		container.querySelector('aside[aria-label="Plugin details"] [aria-label="0 repository stars"]'),
	).not.toBeNull()
	expect(container.querySelector('aside[aria-label="Plugin details"]')?.textContent).toContain(
		'#integration',
	)
	expect(container.querySelector('img')).toBeNull()
	expect(container.querySelector('.pm-readme')!.textContent).toBe('<img src=x onerror=alert(1)>')
	expect(
		[...container.querySelectorAll('button')].some(
			(item) => item.textContent === 'Choose this release',
		),
	).toBe(false)
})

it('shows exact plugin requirements and navigates duplicate README headings within this package', async () => {
	await act(() => root.render(createElement(Marketplace, { data })))
	await click(pkg.name)
	const sidebar = container.querySelector('aside[aria-label="Plugin details"]')!
	const requirements = sidebar.querySelector('[aria-label="Plugin requirements"]')!
	expect(requirements.querySelector('h3')?.textContent).toContain(release.version)
	expect(requirements.textContent).toContain('Pluxel core^1')
	expect(requirements.textContent).toContain('http-plugin^2required')
	expect(requirements.textContent).toContain('log-plugin^3optional')
	expect(sidebar.querySelector('details')?.textContent).toContain('next2.0.0-beta.1')
	const links = sidebar.querySelectorAll<HTMLButtonElement>('nav button')
	const targets = Array.from(links, (link) =>
		document.getElementById(link.getAttribute('aria-controls')!)!,
	)
	expect(targets).toEqual([...container.querySelectorAll('.pm-readme h2')])
	expect(targets).toHaveLength(2)
	targets[1]!.scrollIntoView = vi.fn()
	await act(() => links[1]!.click())
	expect(document.activeElement).toBe(targets[1])
	expect(targets[1]!.scrollIntoView).toHaveBeenCalledOnce()
	await click('Versions')
	expect(sidebar.querySelector('[aria-label="Plugin requirements"], nav')).toBeNull()
})

it('opens same-registry dependency details and returns to the exact release and focused link', async () => {
	const onPackageChange = vi.fn()
	const host: MarketplaceData = {
		...data,
		Package(props) {
			if (props.identity.name === pkg.name) return createElement(data.Package, props)
			if (props.identity.name === 'missing-plugin')
				return props.children({
					data: { ok: false, error: { code: 'NOT_INDEXED', message: 'Not indexed' } },
					isFetching: false,
					refetch: async () => {},
				})
			return props.children(
				read({
					...pkg,
					...props.identity,
					distTags: {},
					metadataVersion: null,
					coverage: 'indexed-only',
					readme: null,
					license: null,
				}),
			)
		},
		Release({ children }) {
			return children(
				read({
					...release,
					peerDependencies: { 'http-plugin': '^2', 'missing-plugin': '^1', react: '^19' },
					pluginPackages: { 'http-plugin': 'required', 'missing-plugin': 'optional' },
				}),
			)
		},
	}
	await act(() => root.render(createElement(Marketplace, { data: host, onPackageChange })))
	await openRelease()
	await click('Dependencies')
	const link = container.querySelector<HTMLButtonElement>('.pm-dependencies button')!
	expect(link.textContent).toBe('http-plugin')
	expect(container.querySelectorAll('.pm-dependencies button')).toHaveLength(3)
	await act(() => link.click())
	expect(onPackageChange).toHaveBeenLastCalledWith({ name: 'http-plugin', registry: pkg.registry })
	const active = () => container.querySelector('.pm-detail-anchor:not([hidden])')!
	expect(active().querySelector('h2')?.textContent).toBe('http-plugin')
	const versionsButton = [...active().querySelectorAll('button')].find(
		(el) => el.textContent === 'Versions',
	)!
	await act(() => versionsButton.click())
	expect(active().querySelector('.pm-version-note')?.textContent).toBe('Outside ^2')
	await click('Back to ' + pkg.name)
	expect(document.activeElement).toBe(link)
	expect(active().querySelector('.pm-dependencies')).not.toBeNull()
	await click('missing-plugin')
	expect(active().textContent).toContain('Not indexed')
	expect(active().textContent).toContain('Search all sources')
	expect(active().querySelector('.pm-release-row')).toBeNull()
	const fetchNpm = vi.fn(async (url: string) => {
		const name = decodeURIComponent(new URL(url).pathname.slice(1))
		const versions = name === 'missing-plugin' ? ['1.1.0', '2.0.0'] : ['3.1.0', '4.0.0']
		return new Response(
			JSON.stringify({
				name,
				'dist-tags': { latest: versions[1] },
				readme: '# Docs for ' + name,
				versions: Object.fromEntries(
					versions.map((version) => [
						version,
						{ name, version, dependencies: name === 'missing-plugin' ? { codec: '^3' } : {} },
					]),
				),
			}),
		)
	})
	vi.stubGlobal('fetch', fetchNpm)
	expect(fetchNpm).not.toHaveBeenCalled()
	await click('Look up missing-plugin on public npm')
	expect(active().textContent).toContain('Docs for missing-plugin')
	expect(active().textContent).toContain('1.1.0')
	expect(fetchNpm).toHaveBeenCalledWith(
		'https://registry.npmjs.org/missing-plugin',
		expect.objectContaining({ credentials: 'omit' }),
	)
	const deps = [...active().querySelectorAll('button')].find(
		(el) => el.textContent === 'Dependencies',
	)!
	await act(() => deps.click())
	await click('codec')
	expect(active().textContent).toContain('Docs for codec')
	expect(active().textContent).toContain('3.1.0')
	await click('Back to missing-plugin')
	expect(active().querySelector('[data-package-dependency="codec"]')).toBe(document.activeElement)
	await click('Back to market details')
	await click('Back to ' + pkg.name)
	await click('missing-plugin')
	await click('Search all sources')
	expect(
		container.querySelector<HTMLInputElement>('input[placeholder="Search packages"]')!.value,
	).toBe('missing-plugin')
	expect(container.querySelector<HTMLElement>('.pm-catalog')!.hidden).toBe(false)
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
	expect(container.textContent).toContain('Showing the first part of this README.')
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
