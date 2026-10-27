// Native formatting bindings belong to Tiptap 3.32.0. This catalog presents them;
// only the UI-owned actions below use matchesShortcut to handle keys.
export const editorShortcuts = {
	undo: 'Mod-z',
	redo: ['Mod-Shift-z', 'Mod-y'],
	bold: 'Mod-b',
	italic: 'Mod-i',
	underline: 'Mod-u',
	strike: 'Mod-Shift-s',
	code: 'Mod-e',
	bulletList: 'Mod-Shift-8',
	orderedList: 'Mod-Shift-7',
	indent: 'Tab',
	outdent: 'Shift-Tab',
	paragraph: 'Mod-Alt-0',
	'heading-1': 'Mod-Alt-1',
	'heading-2': 'Mod-Alt-2',
	'heading-3': 'Mod-Alt-3',
	'heading-4': 'Mod-Alt-4',
	'heading-5': 'Mod-Alt-5',
	'heading-6': 'Mod-Alt-6',
	blockquote: 'Mod-Shift-b',
	codeBlock: 'Mod-Alt-c',
	left: 'Mod-Shift-l',
	center: 'Mod-Shift-e',
	right: 'Mod-Shift-r',
	justify: 'Mod-Shift-j',
	link: 'Mod-k',
	clearFormat: 'Mod-\\',
	format: ['Shift-F10', 'ContextMenu'],
	block: 'Alt-F10',
	finish: 'Mod-Enter',
	cancel: 'Escape',
} as const

export type Shortcut = string | readonly string[]
const alternatives = (shortcut: Shortcut): readonly string[] =>
	typeof shortcut === 'string' ? [shortcut] : shortcut

// Match ProseMirror's Mod convention, including iPad keyboards.
function appleKeyboard() {
	return typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)
}

export function shortcutText(shortcut: Shortcut): string {
	const apple = appleKeyboard()
	const names: Record<string, string> = {
		Mod: apple ? '⌘' : 'Ctrl',
		Shift: apple ? '⇧' : 'Shift',
		Alt: apple ? '⌥' : 'Alt',
		Escape: 'Esc',
		ContextMenu: '菜单键',
	}
	return alternatives(shortcut)
		.map((binding) => {
			const parts = binding.split('-')
			const key = parts.pop()!
			// Conventional macOS modifier order: Option, Shift, Command.
			const modifiers = apple
				? ['Alt', 'Shift', 'Mod'].filter((part) => parts.includes(part))
				: parts
			return [...modifiers, key]
				.map((part) => names[part] ?? (part.length === 1 ? part.toUpperCase() : part))
				.join(apple ? '' : '+')
		})
		.join(' / ')
}

export function shortcutProps(label: string, shortcut?: Shortcut) {
	return {
		title: shortcut ? `${label}（${shortcutText(shortcut)}）` : label,
		'aria-keyshortcuts': shortcut
			? alternatives(shortcut)
					.map((binding) =>
						binding
							.split('-')
							.map((key) =>
								key === 'Mod'
									? appleKeyboard()
										? 'Meta'
										: 'Control'
									: key.length === 1
										? key.toUpperCase()
										: key,
							)
							.join('+'),
					)
					.join(' ')
			: undefined,
	}
}

export function matchesShortcut(
	event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
	shortcut: Shortcut,
): boolean {
	return alternatives(shortcut).some((binding) => {
		const parts = binding.split('-')
		const key = parts.pop()!
		const mod = parts.includes('Mod')
		return (
			event.key.toLowerCase() === key.toLowerCase() &&
			event.ctrlKey === (mod && !appleKeyboard()) &&
			event.metaKey === (mod && appleKeyboard()) &&
			event.shiftKey === parts.includes('Shift') &&
			event.altKey === parts.includes('Alt')
		)
	})
}
