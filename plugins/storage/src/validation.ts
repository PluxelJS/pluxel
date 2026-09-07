export function isS3BucketId(value: string): boolean {
	return /^[a-z][a-z0-9._-]{0,63}$/.test(value)
}
