export type ReportFont = Readonly<{ data: Uint8Array; name?: string }>

/** Data stays immutable until the shared Worker execution has settled. */
export type ReportRenderInput = Readonly<{
	title: string
	engine: 'takumi' | 'heroui'
	fonts: readonly ReportFont[]
}>
