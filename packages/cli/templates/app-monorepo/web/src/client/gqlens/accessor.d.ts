export function useQuery(): {
	readonly greeting: (args: { readonly name?: string | null }) => string
}
