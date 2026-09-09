// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { RuntimeManagementClientProvider } from '@pluxel/runtime/web/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as f from 'valibot-form'
import * as v from 'valibot'

vi.mock('../src/app/plugins/pluginReadModels', () => ({
	refreshPluginReadModels: vi.fn(async () => undefined),
}))

vi.mock('../src/app/plugins/config/components/ConfigActionDock', { spy: true })
vi.mock('../src/app/plugins/config/ConfigTab', { spy: true })

import { ConfigActionDock } from '../src/app/plugins/config/components/ConfigActionDock'
import { ConfigTabContent } from '../src/app/plugins/config/ConfigTab'
import { ConfigForm } from '../src/app/plugins/config/ConfigForm'
import { createManagementQueryClient } from '../src/app/managementQuery'

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
	const queryClient = createManagementQueryClient()
	return (
		<RuntimeManagementClientProvider client={client}>
			<QueryClientProvider client={queryClient}>
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
			</QueryClientProvider>
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
	it('keeps outer controls and sibling panes idle while typing and saves the latest draft', async () => {
		const fields = f.extractFormFields(v.object({ title: v.string() }))
		const patch = vi.fn(async (_owner: PluginNodeAddress, input: Record<string, unknown>) => ({
			ok: true as const,
			config: input,
			application: 'applied' as const,
		}))
		const { container, root } = await mount(
			<ConfigHarness
				client={createFakeManagementClient(patch)}
				sections={[
					{ path: [], fieldName: 'config', fields, defaults: { title: '' } },
					{
						path: ['cache'],
						fieldName: 'cache',
						fields: nestedFields,
						defaults: { enabled: false },
					},
				]}
			/>,
		)
		try {
			const input = container.querySelector<HTMLInputElement>('input[name="title"]')!
			const setValue = (value: string) => {
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
					input,
					value,
				)
				input.dispatchEvent(new Event('input', { bubbles: true }))
			}
			await act(async () => setValue('first edit'))
			expect(buttonWithText(container, '全部保存').disabled).toBe(false)
			const dockCalls = vi.mocked(ConfigActionDock).mock.calls.length
			const paneCalls = vi.mocked(ConfigTabContent).mock.calls.length
			await act(async () => setValue('second edit'))
			await act(async () => setValue('freshest draft'))
			expect(input.value).toBe('freshest draft')
			expect(vi.mocked(ConfigActionDock).mock.calls.length).toBe(dockCalls)
			expect(vi.mocked(ConfigTabContent).mock.calls.length).toBe(paneCalls)
			await act(async () => buttonWithText(container, '全部保存').click())
			expect(patch).toHaveBeenCalledExactlyOnceWith(OWNER, { title: 'freshest draft' })
		} finally {
			await act(async () => root.unmount())
		}
	})

	it.each(['success', 'validation'] as const)(
		'preserves edits made during a pending section save (%s)',
		async (outcome) => {
			let resolve!: (result: unknown) => void
			const patch = vi.fn(
				() =>
					new Promise<any>((done) => {
						resolve = done
					}),
			)
			const { container, root } = await mount(
				<ConfigHarness client={createFakeManagementClient(patch)} />,
			)
			try {
				const input = container.querySelector<HTMLInputElement>('input[name="rootEnabled"]')!
				await act(async () => input.click())
				await act(async () => buttonWithText(container, '保存').click())
				expect(patch).toHaveBeenCalledOnce()
				await act(async () => input.click())
				await act(async () =>
					resolve(
						outcome === 'success'
							? { ok: true, config: { rootEnabled: true }, application: 'applied' }
							: {
									ok: false,
									code: 'validation_failed',
									errors: {
										_root: { rootEnabled: [{ path: ['rootEnabled'], message: 'Stale rejection' }] },
									},
								},
					),
				)
				expect(input.checked).toBe(false)
				expect(container.textContent).not.toContain('Stale rejection')
			} finally {
				await act(async () => root.unmount())
			}
		},
	)

	it.each(['success', 'validation'] as const)(
		'preserves edits made during a pending save-all (%s)',
		async (outcome) => {
			let resolve!: (result: unknown) => void
			const patch = vi.fn(
				() =>
					new Promise<any>((done) => {
						resolve = done
					}),
			)
			const { container, root } = await mount(
				<ConfigHarness
					client={createFakeManagementClient(patch)}
					sections={[
						{ path: [], fieldName: 'config', fields: rootFields, defaults: { rootEnabled: false } },
						{
							path: ['cache'],
							fieldName: 'cache',
							fields: nestedFields,
							defaults: { enabled: false },
						},
					]}
				/>,
			)
			try {
				const input = container.querySelector<HTMLInputElement>('input[name="rootEnabled"]')!
				const sibling = container.querySelector<HTMLInputElement>('input[name="enabled"]')!
				await act(async () => {
					input.click()
					sibling.click()
				})
				await act(async () => buttonWithText(container, '全部保存').click())
				expect(patch).toHaveBeenCalledOnce()
				await act(async () => input.click())
				await act(async () =>
					resolve(
						outcome === 'success'
							? {
									ok: true,
									config: { rootEnabled: true, cache: { enabled: true } },
									application: 'applied',
								}
							: {
									ok: false,
									code: 'validation_failed',
									errors: {
										_root: { rootEnabled: [{ path: ['rootEnabled'], message: 'Stale rejection' }] },
									},
								},
					),
				)
				expect(input.checked).toBe(false)
				expect(sibling.checked).toBe(true)
				expect(container.textContent).not.toContain('Stale rejection')
			} finally {
				await act(async () => root.unmount())
			}
		},
	)

	it('keeps unrelated field errors when another field is corrected', async () => {
		const fields = f.extractFormFields(v.object({ rootEnabled: v.boolean(), other: v.boolean() }))
		const patch = vi.fn().mockResolvedValue({
			ok: false,
			code: 'validation_failed',
			errors: {
				_root: {
					rootEnabled: [{ path: ['rootEnabled'], message: 'First rejected' }],
					other: [{ path: ['other'], message: 'Other rejected' }],
					_root: [{ path: [], message: 'Cross-field rejection' }],
				},
			},
		})
		const { container, root } = await mount(
			<ConfigHarness
				client={createFakeManagementClient(patch)}
				sections={[
					{ path: [], fieldName: 'config', fields, defaults: { rootEnabled: false, other: false } },
				]}
			/>,
		)
		try {
			const input = container.querySelector<HTMLInputElement>('input[name="rootEnabled"]')!
			await act(async () => input.click())
			await act(async () => buttonWithText(container, '保存').click())
			await act(async () => input.click())
			expect(container.textContent).not.toContain('First rejected')
			expect(container.textContent).not.toContain('Cross-field rejection')
			expect(container.textContent).toContain('Other rejected')
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('keeps a newer draft through saved-config propagation and submits it on retry', async () => {
		let resolve!: (result: unknown) => void
		const patch = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise((done) => {
						resolve = done
					}),
			)
			.mockResolvedValue({ ok: true, config: { rootEnabled: false }, application: 'applied' })
		const client = createFakeManagementClient(patch)
		const { container, root } = await mount(<ConfigHarness client={client} />)
		try {
			const input = container.querySelector<HTMLInputElement>('input[name="rootEnabled"]')!
			await act(async () => input.click())
			await act(async () => buttonWithText(container, '保存').click())
			await act(async () => input.click())
			await act(async () => {
				resolve({ ok: true, config: { rootEnabled: true }, application: 'applied' })
				root.render(<ConfigHarness client={client} savedConfig={{ rootEnabled: true }} />)
			})
			expect(container.querySelector<HTMLInputElement>('input[name="rootEnabled"]')!.checked).toBe(
				false,
			)
			expect(buttonWithText(container, '保存').disabled).toBe(false)
			await act(async () => buttonWithText(container, '保存').click())
			expect(patch).toHaveBeenLastCalledWith(OWNER, { rootEnabled: false })
		} finally {
			await act(async () => root.unmount())
		}
	})

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

	it('restores safe defaults while preserving literal root keys and their safe siblings', async () => {
		const fields = f.extractFormFields(
			v.object({
				literal: v.object({ key: v.string() }),
				'literal.key': v.string(),
				'0': v.string(),
				'': v.string(),
				rootEnabled: v.boolean(),
			}),
		)
		const savedConfig = {
			literal: { key: 'nested saved' },
			'literal.key': 'dotted saved',
			'0': 'numeric saved',
			'': 'empty saved',
			rootEnabled: true,
		}
		let persisted = savedConfig
		const patch = vi.fn(async (_owner: PluginNodeAddress, input: Record<string, unknown>) => {
			persisted = { ...persisted, ...input }
			return { ok: true as const, config: persisted, application: 'applied' as const }
		})
		const { container, root } = await mount(
			<ConfigHarness
				client={createFakeManagementClient(patch)}
				savedConfig={savedConfig}
				sections={[
					{
						path: [],
						fieldName: 'config',
						fields,
						defaults: {
							literal: { key: 'nested saved' },
							'literal.key': 'dotted default',
							'0': 'numeric default',
							'': 'empty default',
							rootEnabled: false,
						},
					},
				]}
			/>,
		)
		try {
			await act(async () => buttonWithText(container, '恢复默认').click())
			expect(container.querySelector<HTMLInputElement>('input[name="literal.key"]')?.value).toBe(
				'nested saved',
			)
			expect(container.querySelector<HTMLInputElement>('input[name="rootEnabled"]')?.checked).toBe(
				false,
			)
			expect(buttonWithText(container, '保存').disabled).toBe(false)
			await act(async () => buttonWithText(container, '保存').click())
			expect(patch).toHaveBeenCalledOnce()
			expect(persisted).toEqual({ ...savedConfig, rootEnabled: false })
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('shows server field errors, preserves the draft, and allows saving after correction', async () => {
		const patch = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				code: 'validation_failed',
				state: 'unchanged',
				errors: {
					_root: {
						rootEnabled: [{ path: ['rootEnabled'], message: 'Rejected toggle' }],
						_root: [{ path: [], message: 'Configuration rejected' }],
					},
				},
			})
			.mockResolvedValueOnce({ ok: true, config: { rootEnabled: false }, application: 'applied' })
		const { container, root } = await mount(
			<ConfigHarness client={createFakeManagementClient(patch)} />,
		)
		try {
			const input = container.querySelector<HTMLInputElement>('input[name="rootEnabled"]')!
			await act(async () => input.click())
			await act(async () => buttonWithText(container, '保存').click())
			expect(input.checked).toBe(true)
			expect(container.textContent).toContain('Rejected toggle')
			expect(container.textContent).toContain('Configuration rejected')
			expect(buttonWithText(container, '保存').disabled).toBe(false)
			await act(async () => input.click())
			expect(container.textContent).not.toContain('Rejected toggle')
			expect(container.textContent).not.toContain('Configuration rejected')
			// Return to a dirty value so the dock can submit it again.
			await act(async () => input.click())
			await act(async () => buttonWithText(container, '保存').click())
			expect(patch).toHaveBeenCalledTimes(2)
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
		patch.mockResolvedValueOnce({
			ok: false,
			code: 'validation_failed',
			state: 'unchanged',
			errors: { _root: { cache: [{ path: ['cache', 'enabled'], message: 'Cache rejected' }] } },
		} as never)
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

			expect(nestedToggle.checked).toBe(true)
			expect(container.textContent).toContain('Cache rejected')
			expect(buttonWithText(container, '全部保存').disabled).toBe(false)
			await act(async () => buttonWithText(container, '全部保存').click())
			expect(container.textContent).not.toContain('Cache rejected')
			expect(patch).toHaveBeenCalledTimes(2)
			expect(patch).toHaveBeenCalledWith(OWNER, {
				rootEnabled: true,
				cache: { enabled: true, preserved: 'keep-me' },
			})
		} finally {
			await act(async () => root.unmount())
		}
	})
})
