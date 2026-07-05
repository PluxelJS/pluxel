export interface WorkspacePackageJson {
	name?: string
	version?: string
	main?: string
	module?: string
	types?: string
	exports?: unknown
	workspaces?: string[] | { packages?: string[] }
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
	optionalDependencies?: Record<string, string>
	peerDependencies?: Record<string, string>
	peerDependenciesMeta?: Record<string, { optional?: boolean; dev?: boolean }>
	repository?: string | { type?: string; url?: string }
	homepage?: string
	bugs?: string | { url?: string }
	[key: string]: unknown
}
