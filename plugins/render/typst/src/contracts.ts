/** Trusted template tree. Keep its contents stable until open settles. */
export interface TypstTemplate {
	readonly root: string
	readonly entry: string
}

/** JSON candidates are checked for encodability, never against a business schema. */
export type ResourceSource =
	| { readonly kind: 'json'; readonly value: unknown }
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'bytes'; readonly bytes: Uint8Array }
	| { readonly kind: 'file'; readonly path: string | URL }

/** Canonical absolute /inputs/ paths. Sources remain borrowed until update settles. */
export type TypstFiles = Readonly<Record<string, ResourceSource>>
