// WouterLinkAdapter.tsx
import type React from 'react'
import { forwardRef } from 'react'
import { Link as WLink } from 'wouter'

export type WouterLinkAdapterProps = {
	to: string
	children: React.ReactNode
} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>

export const WouterLinkAdapter = forwardRef<HTMLAnchorElement, WouterLinkAdapterProps>(
	({ to, children, ...rest }, ref) => {
		return (
			<WLink to={to} asChild>
				{/* 用 asChild 自己渲染 <a>，Mantine 传下来的 className/onClick/ref 都能接住 */}
				<a ref={ref} href={to} {...rest}>
					{children}
				</a>
			</WLink>
		)
	},
)
WouterLinkAdapter.displayName = 'WouterLinkAdapter'
