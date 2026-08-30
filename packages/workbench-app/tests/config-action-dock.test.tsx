// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { RuntimeManagementClientProvider } from '@pluxel/runtime/web/react'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as f from 'valibot-form'
import * as v from 'valibot'

vi.mock('../src/app/plugins/pluginReadModels', () => ({
	refreshPluginReadModels: vi.fn(async () => undefined),
}))

import { ConfigForm } from '../src/app/plugins/config/ConfigForm'

const OWNER: PluginNodeAddress = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'pluxel-test:ConfigOwner' },
		exportName: 'Plugin',
	},
	variant: 'default',
}

const rootSchema = v.object({
	rootEnabled: v.pipe(v.boolean(), f.formMeta({ title: '启用根配置' })),
})
const nestedSchema = v.object({
	enabled: v.pipe(v.boolean(), f.formMeta({ title: '启用缓存' })),
})
const rootFields = f.extractFormFields(rootSchema)
const nestedFields = f.extractFormFields(nestedSchema)
const DEFAULT_SAVED_CONFIG = Object.freeze({ rootEnabled: false })

function createFakeManagementClient(
	patch = vi.fn(async (_owner: PluginNodeAddress, input: Record<string, unknown>) => ({
		ok: true as const,
		config: input,
		application: 'applied' as const,
	})),
) {
	return {
		config: {
			patch,
			patchField: vi.fn(),
		},
	} as any
}

function ConfigHarness({
	client = createFakeManagementClient(),
	savedConfig = DEFAULT_SAVED_CONFIG,
	sections,
}: {
	client?: ReturnType<typeof createFakeManagementClient>
	savedConfig?: Record<string, unknown>
	sections?: Array<{
		path: readonly string[]
		fieldName: string
		fields: typeof rootFields
		defaults: Record<string, unknown>
	}>
}) {
	return (
		<RuntimeManagementClientProvider client={client}>
			<MantineProvider>
				<ConfigForm
					owner={OWNER}
					displayName="Config owner"
					fields={rootFields}
					savedConfig={savedConfig}
					defaults={{ rootEnabled: false }}
					sections={sections}
				/>
			</MantineProvider>
		</RuntimeManagementClientProvider>
	)
}

class ResizeObserverMock {
	disconnect() {}
	observe() {}
	unobserve() {}
}

async function mount(ui: ReactNode) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	await act(async () => {
		root.render(ui)
		await Promise.resolve()
	})
	return { container, root }
}

function buttonWithText(container: HTMLElement, text: string) {
	return [...container.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === text,
	) as HTMLButtonElement
}

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
	globalThis.ResizeObserver = ResizeObserverMock as any
	if (typeof window.matchMedia !== 'function') {
		window.matchMedia = ((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})) as typeof window.matchMedia
	}
})

afterEach(() => {
	vi.restoreAllMocks()
	document.body.innerHTML = ''
})

describe('config action dock', () => {
	it('keeps the action group outside and before the scrolling form content', async () => {
		const { container, root } = await mount(<ConfigHarness />)
		try {
			const form = container.querySelector('.plx-pluginWorkbench__configForm')!
			const toolbar = container.querySelector('.plx-pluginWorkbench__configToolbar')!
			const scrollArea = container.querySelector('.plx-pluginWorkbench__configScrollArea')!

			expect(toolbar.parentElement).toBe(form)
			expect(scrollArea.parentElement).toBe(form)
			expect(
				toolbar.compareDocumentPosition(scrollArea) & Node.DOCUMENT_POSITION_FOLLOWING,
			).toBeTruthy()
			expect(toolbar.querySelector('button')?.textContent).toContain('撤销')
			expect(scrollArea.querySelector('.plx-pluginWorkbench__configActionButtons')).toBeNull()
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('saves with Ctrl/Command+S even while a config input has focus', async () => {
		const patch = vi.fn(async () => ({
			ok: true as const,
			config: { rootEnabled: true },
			application: 'applied' as const,
		}))
		const { container, root } = await mount(
			<ConfigHarness client={createFakeManagementClient(patch)} />,
		)
		try {
			const input = container.querySelector('input[name="rootEnabled"]') as HTMLInputElement
			await act(async () => {
				input.click()
				await Promise.resolve()
			})
			expect(buttonWithText(container, '保存').disabled).toBe(false)
			input.focus()
			await act(async () => {
				input.dispatchEvent(
					new KeyboardEvent('keydown', {
						key: 's',
						ctrlKey: true,
						bubbles: true,
						cancelable: true,
					}),
				)
				await Promise.resolve()
				await Promise.resolve()
			})

			expect(patch).toHaveBeenCalledWith(OWNER, expect.objectContaining({ rootEnabled: true }))
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('saves all dirty sections in one patch and preserves unrendered nested values', async () => {
		const patch = vi.fn(async (_owner: PluginNodeAddress, input: Record<string, unknown>) => ({
			ok: true as const,
			config: input,
			application: 'applied' as const,
		}))
		const sections = [
			{
				path: [],
				fieldName: 'config',
				fields: rootFields,
				defaults: { rootEnabled: false },
			},
			{
				path: ['cache'],
				fieldName: 'cache',
				fields: nestedFields,
				defaults: { enabled: false },
			},
		]
		const { container, root } = await mount(
			<ConfigHarness
				client={createFakeManagementClient(patch)}
				savedConfig={{
					rootEnabled: false,
					cache: { enabled: false, preserved: 'keep-me' },
					untouched: 'keep-too',
				}}
				sections={sections}
			/>,
		)
		try {
			const rootToggle = container.querySelector('input[name="rootEnabled"]') as HTMLInputElement
			await act(async () => {
				rootToggle.click()
				await Promise.resolve()
			})
			expect(buttonWithText(container, '保存').disabled).toBe(false)
			const nestedToggle = container.querySelector('input[name="enabled"]') as HTMLInputElement
			await act(async () => {
				nestedToggle.click()
				await Promise.resolve()
			})
			expect(buttonWithText(container, '全部保存').disabled).toBe(false)

			await act(async () => {
				buttonWithText(container, '全部保存').click()
				await Promise.resolve()
				await Promise.resolve()
			})

			expect(patch).toHaveBeenCalledTimes(1)
			expect(patch).toHaveBeenCalledWith(OWNER, {
				rootEnabled: true,
				cache: { enabled: true, preserved: 'keep-me' },
			})
		} finally {
			await act(async () => root.unmount())
		}
	})
})
