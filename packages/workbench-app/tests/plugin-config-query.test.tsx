// @vitest-environment jsdom

import type { PluginNodeAddress } from '@pluxel/core'
import { QueryClientProvider } from '@tanstack/react-query'
import type { RuntimeManagementClient } from '@pluxel/runtime/web'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createManagementQueryClient } from '../src/app/managementQuery'
import {
	commitPluginConfig,
	type PluginConfigState,
	usePluginConfig,
} from '../src/app/plugins/config/usePluginConfig'
import { RuntimeManagementClientProvider } from '../src/runtime'

const firstOwner = owner('First')
const secondOwner = owner('Second')
const mounted: Array<ReturnType<typeof createRoot>> = []

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
	document.body.replaceChildren()
})

describe('plugin config queries', () => {
	it('treats a Plugin without a config schema as an empty config state', async () => {
		const presentation = vi.fn().mockResolvedValue({
			ok: false,
			code: 'presentation_not_found',
			message: 'No config schema is registered for this Plugin node.',
		})
		const get = vi.fn().mockResolvedValue({
			ok: false,
			code: 'config_not_found',
			state: 'unchanged',
			message: 'No config schema is registered for this Plugin node.',
		})
		const client = { config: { presentation, get } } as unknown as RuntimeManagementClient
		const queryClient = createManagementQueryClient()
		let latest: PluginConfigState | undefined

		function Probe() {
			latest = usePluginConfig(firstOwner)
			return null
		}

		const root = createRoot(document.body.appendChild(document.createElement('div')))
		mounted.push(root)
		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={queryClient}>
						<Probe />
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
			await Promise.resolve()
		})
		await act(async () => {
			await vi.waitFor(() =>
				expect(latest?.data).toMatchObject({
					fields: [],
					savedConfig: {},
				}),
			)
		})

		expect(latest?.error).toBeUndefined()
		expect(presentation).toHaveBeenCalledOnce()
		expect(get).toHaveBeenCalledOnce()
	})

	it('shares reads by owner and lets authoritative mutation data update every consumer', async () => {
		const presentation = vi.fn().mockResolvedValue({
			ok: true,
			plan: { fieldName: 'config', fields: [], defaults: {}, sections: [] },
		})
		const get = vi.fn().mockResolvedValue({ ok: true, config: { enabled: true } })
		const client = { config: { presentation, get } } as unknown as RuntimeManagementClient
		const queryClient = createManagementQueryClient()
		const states: PluginConfigState[] = []

		function Probe() {
			states.push(usePluginConfig(firstOwner))
			return null
		}

		const root = createRoot(document.body.appendChild(document.createElement('div')))
		mounted.push(root)
		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={queryClient}>
						<Probe />
						<Probe />
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
			await Promise.resolve()
		})
		await act(async () => {
			await vi.waitFor(() => expect(states.at(-1)?.data).toBeDefined())
		})

		expect(presentation).toHaveBeenCalledOnce()
		expect(get).toHaveBeenCalledOnce()
		await act(async () => {
			commitPluginConfig(queryClient, firstOwner, { enabled: false })
			await vi.waitFor(() => expect(states.at(-1)?.data?.savedConfig).toEqual({ enabled: false }))
		})
	})

	it('does not display the previous owner while a new owner is loading', async () => {
		let releaseSecond!: (value: { ok: true; config: Record<string, unknown> }) => void
		const secondConfig = new Promise<{ ok: true; config: Record<string, unknown> }>((resolve) => {
			releaseSecond = resolve
		})
		const client = {
			config: {
				presentation: vi.fn().mockResolvedValue({
					ok: true,
					plan: { fieldName: 'config', fields: [], defaults: {}, sections: [] },
				}),
				get: vi
					.fn()
					.mockResolvedValueOnce({ ok: true, config: { owner: 'first' } })
					.mockReturnValueOnce(secondConfig),
			},
		} as unknown as RuntimeManagementClient
		const queryClient = createManagementQueryClient()
		let latest: PluginConfigState | undefined

		function Probe({ current }: { current: PluginNodeAddress }) {
			latest = usePluginConfig(current)
			return null
		}

		const root = createRoot(document.body.appendChild(document.createElement('div')))
		mounted.push(root)
		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={queryClient}>
						<Probe current={firstOwner} />
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
			await Promise.resolve()
		})
		await act(async () => {
			await vi.waitFor(() => expect(latest?.data?.savedConfig).toEqual({ owner: 'first' }))
		})

		await act(async () => {
			root.render(
				<RuntimeManagementClientProvider client={client}>
					<QueryClientProvider client={queryClient}>
						<Probe current={secondOwner} />
					</QueryClientProvider>
				</RuntimeManagementClientProvider>,
			)
			await Promise.resolve()
		})
		expect(latest?.loading).toBe(true)
		expect(latest?.data).toBeUndefined()

		await act(async () => {
			releaseSecond({ ok: true, config: { owner: 'second' } })
			await vi.waitFor(() => expect(latest?.data?.savedConfig).toEqual({ owner: 'second' }))
		})
	})
})

function owner(exportName: string): PluginNodeAddress {
	return {
		definition: {
			entry: { kind: 'package-root', packageName: '@fixture/config-query' },
			exportName,
		},
		variant: 'default',
	}
}
