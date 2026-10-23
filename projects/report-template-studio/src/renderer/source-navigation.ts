/** Worksplit retains inactive tabs; only a visible counterpart participates. */
export function isPaneVisible(element: HTMLElement | null): boolean {
	if (!element?.isConnected) return false
	const bounds = element.getBoundingClientRect()
	if (bounds.width === 0 || bounds.height === 0) return false
	return (
		element.checkVisibility?.({ checkVisibilityCSS: true }) ?? element.getClientRects().length > 0
	)
}
