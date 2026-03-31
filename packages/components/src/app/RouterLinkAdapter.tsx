import type React from 'react'
import { forwardRef, useCallback } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useWorkbenchTabs, type WorkbenchNavigationRequest } from './workbench/context'

export type RouterLinkAdapterProps = {
	to: string
	children: React.ReactNode
	workbenchMode?: WorkbenchNavigationRequest
} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>

export const RouterLinkAdapter = forwardRef<HTMLAnchorElement, RouterLinkAdapterProps>(
	({ to, children, onClick, target, rel, workbenchMode = 'auto', ...rest }, ref) => {
		const router = useRouter()
		const navigate = useNavigate()
		const workbenchTabs = useWorkbenchTabs()

		let href = to
		try {
			href = router.buildLocation({ to }).href
		} catch {
			// 保底回退到原始 to
		}

		const handleClick = useCallback(
			(event: React.MouseEvent<HTMLAnchorElement>) => {
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

				event.preventDefault()
				workbenchTabs.requestNavigation(to, workbenchMode)
				if (to === '/') {
					// 主动点击首页链接时，通过 state 传递 manual 标记
					navigate({
						to,
						state: (prev) => ({ ...(prev as any), manual: true }) as any,
					})
				} else {
					navigate({ to })
				}
			},
			[navigate, onClick, target, to, workbenchMode, workbenchTabs],
		)

		return (
			<a ref={ref} href={href} target={target} rel={rel} onClick={handleClick} {...rest}>
				{children}
			</a>
		)
	},
)
RouterLinkAdapter.displayName = 'RouterLinkAdapter'
