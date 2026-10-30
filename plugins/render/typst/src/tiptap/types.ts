/** Derived native-label target for the current source revision. */
export interface TypstReferenceTarget {
	label: string
	kind: 'figure' | 'table' | 'equation'
	path: string
	title: string
	/** Native ProseMirror position before the target node. */
	position: number
}
