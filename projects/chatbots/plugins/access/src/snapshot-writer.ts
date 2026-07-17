/** Coalesces bursts while preserving the latest snapshot produced during an active write. */
export class CoalescedSnapshotWriter {
	private dirty = false
	private task?: Promise<void>

	constructor(
		private readonly snapshot: () => string,
		private readonly write: (snapshot: string) => Promise<void>,
		private readonly onError: (error: unknown) => void,
	) {}

	request(): void {
		this.dirty = true
		this.task ??= Promise.resolve()
			.then(() => this.flush())
			.finally(() => {
				this.task = undefined
				if (this.dirty) this.request()
			})
	}

	async drain(): Promise<void> {
		while (this.task) await this.task
	}

	private async flush(): Promise<void> {
		while (this.dirty) {
			this.dirty = false
			try {
				await this.write(this.snapshot())
			} catch (error) {
				this.onError(error)
			}
		}
	}
}
