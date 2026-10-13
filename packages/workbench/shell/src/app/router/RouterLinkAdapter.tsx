import {
	forwardRef,
	useCallback,
	type ComponentPropsWithoutRef,
	type MouseEvent,
	type ReactNode,
} from 'react'
import { useRouter } from '@tanstack/react-router'
import { useOptionalWorkspaceSession } from '../workbench/workspaceContext'
import { useWorkbenchNavigation } from '../workbench/context'

export type RouterLinkAdapterProps = {
	to: string
	children: ReactNode
} & Omit<ComponentPropsWithoutRef<'a'>, 'href'>

export const RouterLinkAdapter = forwardRef<HTMLAnchorElement, RouterLinkAdapterProps>(
	({ to, children, onClick, target, rel, ...rest }, ref) => {
		const router = useRouter({ warn: false })
		const session = useOptionalWorkspaceSession()
		const { navigate } = useWorkbenchNavigation()
		const isWorkbenchPath = to.startsWith('/') && !to.startsWith('//') && !to.includes('\\')

		let href = to
		if (isWorkbenchPath) {
			try {
				href = router
					? router.buildLocation({ to }).href
					: `${session?.basepath === '/' ? '' : (session?.basepath ?? '')}${to}`
			} catch {
				// Preserve the original href if the router cannot resolve it.
			}
		}

		const handleClick = useCallback(
			(event: MouseEvent<HTMLAnchorElement>) => {
				onClick?.(event)
				if (
					!isWorkbenchPath ||
					event.defaultPrevented ||
					event.currentTarget.hasAttribute('download') ||
					event.button !== 0 ||
					(target && target !== '_self') ||
					event.metaKey ||
					event.altKey ||
					event.ctrlKey ||
					event.shiftKey
				) {
					return
				}

				// Workspace navigation owns deduplication and focus, including links in inactive panes.
				event.preventDefault()
				navigate(to)
			},
			[isWorkbenchPath, navigate, onClick, target, to],
		)

		return (
			<a ref={ref} href={href} target={target} rel={rel} onClick={handleClick} {...rest}>
				{children}
			</a>
		)
	},
)
RouterLinkAdapter.displayName = 'RouterLinkAdapter'
