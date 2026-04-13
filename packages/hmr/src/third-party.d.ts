declare module 'picomatch' {
	export type PicomatchOptions = {
		dot?: boolean
	}

	export type Matcher = (input: string) => boolean

	export default function picomatch(
		glob: string | readonly string[],
		options?: PicomatchOptions,
	): Matcher
}
