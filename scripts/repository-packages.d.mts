export declare const repositoryRoot: string
export declare function rootWorkspaceDependencyErrors(manifest: any, packages: any): string[]
export declare function isPublishablePackage({
	kind,
	manifest,
}: {
	kind: any
	manifest: any
}): boolean
/**
 * Local tarballs needed by a published consumer; development and optional peer links stay external.
 * @param {Awaited<ReturnType<typeof readRepositoryPackages>>} packages
 * @param {readonly string[]} roots
 * @returns {Awaited<ReturnType<typeof readRepositoryPackages>>}
 */
export declare function publishPackageClosure(
	packages: Awaited<ReturnType<typeof readRepositoryPackages>>,
	roots: readonly string[],
): Awaited<ReturnType<typeof readRepositoryPackages>>
export declare function tegamiIgnorePattern(packages: any): RegExp
export declare function packagesRequiringInitialMajor(packages: any): any
export declare function releasePackageErrors(packages: any): string[]
export declare function workspaceOnlyDependencyErrors(packages: any): string[]
/**
 * @returns {Promise<Array<{
 *   packageRoot: string,
 *   manifestPath: string,
 *   directory: string,
 *   kind: 'root' | 'package' | 'plugin' | 'project' | 'vendor',
 *   manifest: Record<string, any>
 * }>>}
 */
export declare function readRepositoryPackages(root?: string): Promise<
	Array<{
		packageRoot: string
		manifestPath: string
		directory: string
		kind: 'root' | 'package' | 'plugin' | 'project' | 'vendor'
		manifest: Record<string, any>
	}>
>
export declare const repositoryPackages: {
	packageRoot: string
	manifestPath: string
	directory: string
	kind: 'root' | 'package' | 'plugin' | 'project' | 'vendor'
	manifest: Record<string, any>
}[]
