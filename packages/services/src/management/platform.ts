/** Browser-safe facts about the current JavaScript and deployment environment. */
export type PluxelPlatformSnapshot = Readonly<{
	runtime: Readonly<{
		name: string | null
		version: string | null
	}>
	deployment: Readonly<{
		provider: string | null
		ci: boolean
	}>
	mode: 'development' | 'production' | 'test' | 'unknown'
	platform: string | null
}>
