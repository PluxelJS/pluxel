// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { workbenchContract } from '../../src/workbench/contracts'
import { createWorkbenchUi, WorkbenchViewProvider } from '../../src/workbench/ui-runtime'

const contract = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<{ ping(): string }>(),
	},
	views: {},
})
const ui = createWorkbenchUi(contract)
const mounted: Array<ReturnType<typeof createRoot>> = []

beforeAll(() => {
	globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
	await act(async () => {
		for (const root of mounted.splice(0)) root.unmount()
	})
})

describe('Workbench UI resource facade', () => {
	it('is a frozen reflection-safe record backed only by granted resources', async () => {
		const commands = { ping: vi.fn(() => 'pong') }
		let resources: ReturnType<typeof ui.useResources> | undefined
		const container = document.createElement('div')
		document.body.appendChild(container)
		const root = createRoot(container)
		mounted.push(root)

		function Probe() {
			resources = ui.useResources()
			return null
		}

		await act(async () => {
			root.render(
				<WorkbenchViewProvider
					item={
						{
							viewId: 'Access',
							model: { commands: { kind: 'rpc', grantId: 'commands-grant' } },
						} as never
					}
					environment={
						{
							transport: { workbench: { rpc: () => commands } },
						} as never
					}
				>
					<Probe />
				</WorkbenchViewProvider>,
			)
		})

		expect(resources?.commands).toBe(commands)
		expect(Object.isFrozen(resources)).toBe(true)
		expect(Reflect.get(resources as object, '$$typeof')).toBeUndefined()
		expect(Reflect.get(resources as object, 'missing')).toBeUndefined()
	})
})
