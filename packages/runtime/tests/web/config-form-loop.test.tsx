// @vitest-environment jsdom

import { MantineProvider } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { RuntimeManagementClientProvider } from '../../src/web/react'
import { act, useMemo, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as f from 'valibot-form'
import * as v from 'valibot'
import { ConfigForm } from '../../../workbench-app/src/app/plugins/config/ConfigForm'
import {
	PluginWorkbenchAsideProvider,
	usePluginWorkbenchAssistVisibility,
} from '../../../workbench-app/src/app/plugins/detail/workbench/context'
import { resolvePluginWorkbenchPanelsState } from '../../../workbench-app/src/app/workbench/split'

const OWNER: PluginNodeAddress = {
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'app', path: 'pluxel-test:ConfigOwner' },
		exportName: 'Plugin',
	},
	variant: 'default',
}

const EMPTY_CONFIG = Object.freeze({ name: '', enabled: false })

const schema = v.object({
	name: v.pipe(
		v.string(),
		f.formMeta({ title: '名称' }),
		f.stringMeta({ placeholder: '输入名称' }),
	),
	enabled: v.pipe(v.boolean(), f.formMeta({ title: '启用' })),
})
const fields = f.extractFormFields(schema)

function createFakeManagementClient(
	patchPluginConfig = vi.fn(async () => ({
		ok: true as const,
		config: { name: 'saved', enabled: false },
		application: 'applied' as const,
	})),
) {
	return {
		config: {
			patch: patchPluginConfig,
			patchField: vi.fn(),
		},
	} as any
}

function ConfigHarness({
	client,
	savedConfig = EMPTY_CONFIG,
	defaults = EMPTY_CONFIG,
}: {
	client?: ReturnType<typeof createFakeManagementClient>
	savedConfig?: Record<string, unknown>
	defaults?: Record<string, unknown>
}) {
	const [dirty, setDirty] = useState(false)
	const resolvedClient = useMemo(() => client ?? createFakeManagementClient(), [client])
	return (
		<RuntimeManagementClientProvider client={resolvedClient}>
			<MantineProvider>
				<div data-dirty={dirty ? 'true' : 'false'}>
					<ConfigForm
						owner={OWNER}
						displayName="Config owner"
						fields={fields}
						savedConfig={savedConfig}
						defaults={defaults}
						onDirtyChange={setDirty}
					/>
				</div>
			</MantineProvider>
		</RuntimeManagementClientProvider>
	)
}

function AssistVisibilityClaim({ visible }: { visible: boolean }) {
	usePluginWorkbenchAssistVisibility(visible)
	return null
}

function AssistClaimHarness({
	firstVisible,
	secondVisible,
}: {
	firstVisible: boolean
	secondVisible: boolean
}) {
	const [assistHost, setAssistHost] = useState<HTMLDivElement | null>(null)
	const [assistVisible, setAssistVisible] = useState(false)
	const claims = useMemo(() => new Map<symbol, true>(), [])
	const asideValue = useMemo(
		() => ({
			asideAvailable: true,
			assistHost,
			setAssistHost,
			assistVisible,
			setAssistClaim(owner: symbol, visible: boolean) {
				if (visible) claims.set(owner, true)
				else claims.delete(owner)
				setAssistVisible(claims.size > 0)
			},
		}),
		[assistHost, assistVisible, claims],
	)
	return (
		<MantineProvider>
			<PluginWorkbenchAsideProvider value={asideValue}>
				<AssistVisibilityClaim visible={firstVisible} />
				<AssistVisibilityClaim visible={secondVisible} />
				<div data-assist-visible={assistVisible ? 'true' : 'false'} ref={setAssistHost} />
			</PluginWorkbenchAsideProvider>
		</MantineProvider>
	)
}

class ResizeObserverMock {
	disconnect() {}
	observe() {}
	unobserve() {}
}

async function typeIntoInput(input: HTMLInputElement, value: string) {
	await act(async () => {
		const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
		descriptor?.set?.call(input, value)
		input.dispatchEvent(new Event('input', { bubbles: true }))
		input.dispatchEvent(new Event('change', { bubbles: true }))
		await Promise.resolve()
	})
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

describe('single-schema ConfigForm safety', () => {
	it('keeps plugin panels visible by default without overriding explicit choices', () => {
		expect(resolvePluginWorkbenchPanelsState(undefined)).toEqual({
			rightPaneVisible: true,
			dockVisible: true,
		})
		expect(
			resolvePluginWorkbenchPanelsState({ rightPaneVisible: false, dockVisible: false }),
		).toEqual({
			rightPaneVisible: false,
			dockVisible: false,
		})
	})

	it('submits one schema against the structured owner address', async () => {
		const patchPluginConfig = vi.fn(async () => ({
			ok: true as const,
			config: { name: 'changed', enabled: false },
			application: 'applied' as const,
		}))
		const { container, root } = await mount(
			<ConfigHarness client={createFakeManagementClient(patchPluginConfig)} />,
		)
		try {
			const input = container.querySelector('input[name="name"]') as HTMLInputElement
			await typeIntoInput(input, 'changed')
			const save = [...container.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === '保存',
			) as HTMLButtonElement
			expect(save.disabled).toBe(false)
			await act(async () => {
				save.click()
				await Promise.resolve()
				await Promise.resolve()
			})
			expect(patchPluginConfig).toHaveBeenCalledWith(
				OWNER,
				expect.objectContaining({ name: 'changed' }),
			)
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('resets to defaults and reports dirty without a render loop', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const { container, root } = await mount(
			<ConfigHarness
				savedConfig={{ name: 'saved', enabled: false }}
				defaults={{ name: 'default', enabled: false }}
			/>,
		)
		try {
			const reset = [...container.querySelectorAll('button')].find(
				(button) => button.textContent?.trim() === '恢复默认',
			) as HTMLButtonElement
			await act(async () => {
				reset.click()
				await Promise.resolve()
			})
			expect((container.querySelector('input[name="name"]') as HTMLInputElement).value).toBe(
				'default',
			)
			expect(container.querySelector('[data-dirty="true"]')).toBeTruthy()
			expect(error.mock.calls.flat().join('\n')).not.toContain('Maximum update depth exceeded')
		} finally {
			await act(async () => root.unmount())
		}
	})

	it('keeps the assist area visible while another claim remains active', async () => {
		const { container, root } = await mount(<AssistClaimHarness firstVisible secondVisible />)
		try {
			expect(container.querySelector('[data-assist-visible="true"]')).toBeTruthy()
			await act(async () => {
				root.render(<AssistClaimHarness firstVisible={false} secondVisible />)
				await Promise.resolve()
			})
			expect(container.querySelector('[data-assist-visible="true"]')).toBeTruthy()
			await act(async () => {
				root.render(<AssistClaimHarness firstVisible={false} secondVisible={false} />)
				await Promise.resolve()
			})
			expect(container.querySelector('[data-assist-visible="false"]')).toBeTruthy()
		} finally {
			await act(async () => root.unmount())
		}
	})
})
