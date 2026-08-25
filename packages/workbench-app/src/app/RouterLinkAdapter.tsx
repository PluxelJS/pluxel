import {
	forwardRef,
	useCallback,
	type ComponentPropsWithoutRef,
	type MouseEvent,
	type ReactNode,
} from 'react'
import { useRouter } from '@tanstack/react-router'
import { useWorkbenchDocumentPathname, useWorkbenchNavigation } from './workbench/context'

export type RouterLinkAdapterProps = {
	to: string
	children: ReactNode
} & Omit<ComponentPropsWithoutRef<'a'>, 'href'>

export const RouterLinkAdapter = forwardRef<HTMLAnchorElement, RouterLinkAdapterProps>(
	({ to, children, onClick, target, rel, ...rest }, ref) => {
		const router = useRouter()
		const { navigate } = useWorkbenchNavigation()
		const documentPathname = useWorkbenchDocumentPathname()

		let href = to
		try {
			href = router.buildLocation({ to }).href
		} catch {
			// 保底回退到原始 to
		}

		const handleClick = useCallback(
			(event: MouseEvent<HTMLAnchorElement>) => {
				onClick?.(event)
				if (
					event.defaultPrevented ||
					event.button !== 0 ||
					(target && target !== '_self') ||
					event.metaKey ||
					event.altKey ||
					event.ctrlKey ||
					event.shiftKey
				) {
					return
				}

				const targetIsCurrent = (() => {
					try {
						const targetUrl = new URL(href, window.location.origin)
						return targetUrl.pathname === documentPathname
					} catch {
						return false
					}
				})()
				if (targetIsCurrent && to !== '/') {
					event.preventDefault()
					return
				}
				event.preventDefault()
				navigate(to)
			},
			[documentPathname, href, navigate, onClick, target, to],
		)

		return (
			<a ref={ref} href={href} target={target} rel={rel} onClick={handleClick} {...rest}>
				{children}
			</a>
		)
	},
)
RouterLinkAdapter.displayName = 'RouterLinkAdapter'
