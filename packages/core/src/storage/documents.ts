/** Borrowed storage for Host-owned config/state documents. The provider owns backend closure. */
export interface HostDocumentStorage {
	/** Only a missing document returns undefined; other failures reject. */
	getText(key: string): Promise<string | undefined>
	/** Resolve after a complete atomic commit; readers observe the previous or complete new document. */
	put(key: string, value: string): Promise<void>
	/** Only existence is required; providers may return their existing file metadata. */
	stat(key: string): Promise<object | undefined>
}
