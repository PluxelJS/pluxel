import { MantineProvider } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { act, useMemo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'
import { Workbench } from '@worksplit/react'
import type { WorkspaceSession } from '../../src/app/workbench/session'
import { WorkspaceSessionProvider } from '../../src/app/workbench/workspaceContext'
import {
	WorkbenchNavigationProvider,
	type WorkbenchNavigationContextValue,
} from '../../src/app/workbench/context'

/** Native Layout must receive geometry in jsdom for its real content portals to mount. */
export function prepareNativeWorkbenchDom() {
	vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
		() => new DOMRect(0, 0, 1200, 800),
	)
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
	vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800)
	vi.stubGlobal(
		'ResizeObserver',
		class implements ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal('scrollTo', vi.fn())
	vi.stubGlobal(
		'matchMedia',
		vi.fn((query: string): MediaQueryList => ({
			matches: false,
			media: query,
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent: () => false,
		})),
	)
}

export function WorkspaceProviders({
	session,
	children,
	colorScheme = 'light',
}: {
	session: WorkspaceSession
	children: ReactNode
	colorScheme?: 'light' | 'dark'
}) {
	const navigation = useMemo<WorkbenchNavigationContextValue>(
		() => ({
			navigate: (path) => {
				void session.workbench.open({ to: path }).then((result) => session.check(result))
			},
			openTab: ({ path }) => {
				void session.workbench
					.open({ to: path }, { newInstance: true })
					.then((result) => session.check(result))
			},
		}),
		[session],
	)
	return (
		<MantineProvider env="test" forceColorScheme={colorScheme}>
			<ModalsProvider>
				<WorkspaceSessionProvider value={session}>
					<WorkbenchNavigationProvider value={navigation}>{children}</WorkbenchNavigationProvider>
				</WorkspaceSessionProvider>
			</ModalsProvider>
		</MantineProvider>
	)
}

export async function renderWorkspace(
	session: WorkspaceSession,
	children = <Workbench workbench={session.workbench} />,
) {
	const container = document.body.appendChild(document.createElement('div'))
	const root = createRoot(container, { onCaughtError: () => undefined })
	await act(async () => {
		root.render(<WorkspaceProviders session={session}>{children}</WorkspaceProviders>)
	})
	return { container, root }
}

export async function openDocument(session: WorkspaceSession, href: string, newInstance = false) {
	let documentId = ''
	await act(async () => {
		const result = await session.workbench.open({ to: href }, { newInstance })
		if (result.status !== 'committed') throw new Error(`Open ${href}: ${JSON.stringify(result)}`)
		documentId = result.document.id
	})
	return documentId
}
