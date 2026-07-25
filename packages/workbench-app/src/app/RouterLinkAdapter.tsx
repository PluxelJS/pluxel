import {
	forwardRef,
	useCallback,
	type ComponentPropsWithoutRef,
	type MouseEvent,
	type ReactNode,
} from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useWorkbenchNavigation, type WorkbenchNavigationRequest } from './workbench/context'

export type RouterLinkAdapterProps = {
	to: string
	children: ReactNode
	workbenchMode?: WorkbenchNavigationRequest
} & Omit<ComponentPropsWithoutRef<'a'>, 'href'>

export const RouterLinkAdapter = forwardRef<HTMLAnchorElement, RouterLinkAdapterProps>(
	({ to, children, onClick, target, rel, workbenchMode = 'auto', ...rest }, ref) => {
		const router = useRouter()
		const navigate = useNavigate()
		const { requestNavigation } = useWorkbenchNavigation()

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
						return (
							targetUrl.pathname === window.location.pathname &&
							targetUrl.search === window.location.search
						)
					} catch {
						return false
					}
				})()
				if (targetIsCurrent && to !== '/') {
					event.preventDefault()
					return
				}
				event.preventDefault()
				requestNavigation(to, workbenchMode)
				if (to === '/') {
					// 主动点击首页链接时，通过 state 传递 manual 标记
					void navigate({
						to,
						state: (prev) => ({ ...(prev as any), manual: true }) as any,
					})
				} else {
					void navigate({ to })
				}
			},
			[href, navigate, onClick, requestNavigation, target, to, workbenchMode],
		)

		return (
			<a ref={ref} href={href} target={target} rel={rel} onClick={handleClick} {...rest}>
				{children}
			</a>
		)
	},
)
RouterLinkAdapter.displayName = 'RouterLinkAdapter'
