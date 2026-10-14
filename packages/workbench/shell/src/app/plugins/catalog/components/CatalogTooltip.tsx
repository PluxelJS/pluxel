import { Tooltip, type TooltipProps } from '@mantine/core'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

const Scrolling = createContext(false)

/** Scrolling the directory dismisses hints and prevents new ones until it settles. */
export function CatalogHints({ children }: { children: ReactNode }) {
	const [scrolling, setScrolling] = useState(false)
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	useEffect(() => () => clearTimeout(timer.current), [])
	const dismiss = () => {
		setScrolling(true)
		clearTimeout(timer.current)
		timer.current = setTimeout(() => setScrolling(false), 800)
	}
	return (
		<Scrolling.Provider value={scrolling}>
			<div style={{ display: 'contents' }} onScrollCapture={dismiss} onWheelCapture={dismiss}>
				{children}
			</div>
		</Scrolling.Provider>
	)
}

export function CatalogTooltip(props: TooltipProps) {
	const scrolling = useContext(Scrolling)
	return (
		<Tooltip
			{...props}
			openDelay={800}
			closeDelay={0}
			disabled={scrolling || props.disabled}
			transitionProps={scrolling ? { duration: 0 } : props.transitionProps}
		/>
	)
}
