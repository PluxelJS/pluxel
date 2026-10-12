import type { BaseIssue, BaseSchema, InferOutput } from 'valibot'

/** Synchronous object schemas supported by the document input/form contract. */
export type TypstDocumentSchema = BaseSchema<
	unknown,
	Record<string, unknown>,
	BaseIssue<unknown>
> & {
	readonly type: 'object' | 'strict_object' | 'loose_object' | 'object_with_rest'
}

/** Generated data belongs to the virtual /inputs/ tree, not the source workspace. */
export type TypstDocumentFiles = Record<
	`/inputs/${string}`,
	{ kind: 'json'; value: unknown } | { kind: 'text'; text: string }
>

export interface TypstDocumentDefinition<Schema extends TypstDocumentSchema> {
	/** Typst source path relative to this document's TypeScript entry. */
	template: string
	/** Valibot defaults supply initial input; parsed output is passed to createFiles. */
	schema: Schema
	/** Omit to generate /inputs/data.json from validated input. Must be synchronous. */
	createFiles?: (data: InferOutput<Schema>) => TypstDocumentFiles
}

/** Defines a document without loading the native compiler, Node APIs or any host services. */
export function defineTypstDocument<Schema extends TypstDocumentSchema>(
	definition: TypstDocumentDefinition<Schema>,
): TypstDocumentDefinition<Schema> {
	return definition
}
