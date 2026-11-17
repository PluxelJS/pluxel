import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import type { Editor } from '@tiptap/core'
import { FloatingMenu } from './floating-menu.js'

function focusPanel(panel: HTMLElement) {
	const field = panel.querySelector<HTMLElement>(
		'input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
	)
	;(field ?? panel.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({
		preventScroll: true,
	})
}

/** Keep blur-driven path completion changes from moving an action before its click arrives. */
export function preserveSourceButtonFocus(event: MouseEvent) {
	if (event.button === 0 && (event.target as Element).closest?.('button:not(:disabled)'))
		event.preventDefault()
}

/** Hidden editor tabs keep their drafts without taking over another editor's controls. */
export function findPendingSourceInput(document: Document): HTMLElement | undefined {
	return [
		...document.querySelectorAll<HTMLElement>('.typst-floating-menu [data-typst-unapplied]'),
	].find(
		(element) =>
			element.getClientRects().length > 0 &&
			document.defaultView!.getComputedStyle(element).visibility !== 'hidden',
	)
}

/** Reopening a control preserves its draft; another unapplied popup owns the next edit. */
export function focusOpenSourcePanel(anchor: HTMLElement | null): boolean {
	if (!anchor) return false
	const document = anchor.ownerDocument
	const controlled = document.getElementById(anchor.getAttribute('aria-controls') ?? '')
	// The editor also uses aria-controls for a completion list; it is not an open form.
	const own =
		controlled?.getAttribute('role') === 'dialog' || controlled?.querySelector('[role="dialog"]')
			? controlled
			: null
	const pending = findPendingSourceInput(document)
	const panel = own ?? pending?.closest<HTMLElement>('.typst-floating-menu')
	if (!panel) return false
	focusPanel(panel)
	return true
}

/** Explicit completion returns to its trigger; outside clicks keep their own focus target. */
export function restoreSourceFocus(anchor: HTMLElement | null, editor: Editor) {
	if (anchor?.isConnected && !anchor.hasAttribute('disabled')) anchor.focus({ preventScroll: true })
	else if (!editor.isDestroyed && editor.view.dom.isConnected) editor.view.focus()
}

/** Portal forms need their own composition guard; the editor's composing flag is unrelated. */
export function useSourceFormComposition(element: RefObject<HTMLElement | null>): () => boolean {
	const composing = useRef(false)
	useEffect(() => {
		const target = element.current
		if (!target) return
		const start = () => {
			composing.current = true
		}
		const end = () => {
			composing.current = false
		}
		const keydown = (event: KeyboardEvent) => {
			if (event.key === 'Enter' && (event.isComposing || composing.current)) {
				event.preventDefault()
				event.stopPropagation()
			}
		}
		const submit = (event: Event) => {
			if (composing.current) {
				event.preventDefault()
				event.stopPropagation()
			}
		}
		target.addEventListener('compositionstart', start, true)
		target.addEventListener('compositionend', end, true)
		target.addEventListener('focusout', end, true)
		target.addEventListener('keydown', keydown, true)
		target.addEventListener('submit', submit, true)
		return () => {
			composing.current = false
			target.removeEventListener('compositionstart', start, true)
			target.removeEventListener('compositionend', end, true)
			target.removeEventListener('focusout', end, true)
			target.removeEventListener('keydown', keydown, true)
			target.removeEventListener('submit', submit, true)
		}
	}, [element])
	return useCallback(() => composing.current, [])
}

/** Source node controls share the editor's existing floating surface and native form behavior. */
export function SourcePopover({
	editor,
	anchor,
	title,
	description,
	dirty,
	onClose,
	children,
}: {
	editor: Editor
	anchor: RefObject<HTMLButtonElement | null>
	title: string
	description?: string
	dirty: boolean
	onClose(restoreFocus?: boolean): void
	children: ReactNode
}) {
	const popup = useRef<HTMLDivElement>(null)
	const id = useId()
	const isComposing = useSourceFormComposition(popup)
	const latest = useRef({ dirty, onClose })
	latest.current = { dirty, onClose }
	useEffect(() => {
		const document = editor.view.dom.ownerDocument
		const window = document.defaultView
		const button = anchor.current
		const element = popup.current
		button?.setAttribute('aria-controls', id)
		const outside = (event: Event) => {
			if (
				!latest.current.dirty &&
				!popup.current?.contains(event.target as Node) &&
				!anchor.current?.contains(event.target as Node)
			)
				latest.current.onClose(false)
		}
		const keydown = (event: KeyboardEvent) => {
			if (editor.view.dom.getClientRects().length === 0) return
			const inside = popup.current?.contains(event.target as Node)
			if (
				event.isComposing ||
				isComposing() ||
				event.defaultPrevented ||
				(!inside &&
					(!latest.current.dirty || (event.target as Element).closest?.('[role="dialog"]')))
			)
				return
			if (event.key === 'Escape') {
				event.preventDefault()
				latest.current.onClose()
			} else if (inside && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
				event.preventDefault()
				popup.current?.querySelector('form')?.requestSubmit()
			}
		}
		const blur = () => {
			if (!latest.current.dirty) latest.current.onClose(false)
		}
		document.addEventListener('pointerdown', outside, true)
		document.addEventListener('focusin', outside)
		document.addEventListener('keydown', keydown)
		element?.addEventListener('mousedown', preserveSourceButtonFocus)
		window?.addEventListener('blur', blur)
		return () => {
			document.removeEventListener('pointerdown', outside, true)
			document.removeEventListener('focusin', outside)
			document.removeEventListener('keydown', keydown)
			element?.removeEventListener('mousedown', preserveSourceButtonFocus)
			window?.removeEventListener('blur', blur)
			if (button?.getAttribute('aria-controls') === id) button.removeAttribute('aria-controls')
		}
	}, [editor, anchor, id, isComposing])
	return (
		<FloatingMenu
			editor={editor}
			reference={() => anchor.current!.getBoundingClientRect()}
			className="typst-node-panel"
			elementRef={popup}
			onReady={() => {
				if (popup.current) focusPanel(popup.current)
			}}
		>
			<section id={id} role="dialog" aria-label={title}>
				<div className="typst-node-panel-heading">
					<strong>{title}</strong>
					<button type="button" aria-label={`关闭${title}`} onClick={() => onClose()}>
						×
					</button>
				</div>
				{description && <p className="typst-node-panel-description">{description}</p>}
				{children}
			</section>
		</FloatingMenu>
	)
}

export function SourceActions({
	label,
	disabled,
	onCancel,
}: {
	label: string
	disabled?: boolean
	onCancel(): void
}) {
	return (
		<div className="typst-node-panel-actions">
			<button type="submit" aria-label={label} disabled={disabled}>
				应用
			</button>
			<button type="button" onClick={() => onCancel()}>
				取消
			</button>
		</div>
	)
}
