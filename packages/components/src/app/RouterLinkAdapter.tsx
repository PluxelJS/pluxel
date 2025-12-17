import type React from 'react'
import { forwardRef, useCallback } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { HOME_MANUAL_KEY } from './constants'

export type RouterLinkAdapterProps = {
	to: string
	children: React.ReactNode
} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>

export const RouterLinkAdapter = forwardRef<HTMLAnchorElement, RouterLinkAdapterProps>(
	({ to, children, onClick, target, rel, ...rest }, ref) => {
		const router = useRouter()
		const navigate = useNavigate()

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
				if (to === '/') {
					try {
						window.sessionStorage.setItem(HOME_MANUAL_KEY, 'true')
					} catch {}
				}
				void navigate({ to })
			},
			[navigate, onClick, target, to],
		)

		return (
			<a ref={ref} href={href} target={target} rel={rel} onClick={handleClick} {...rest}>
				{children}
			</a>
		)
	},
)
RouterLinkAdapter.displayName = 'RouterLinkAdapter'
