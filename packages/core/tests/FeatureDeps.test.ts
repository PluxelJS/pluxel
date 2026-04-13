import { describe, expect, it } from 'vitest'

import { BasePlugin, Plugin, withHost } from '@pluxel/test'

describe('FeatureHost.dep', () => {
	it('returns undefined when missing and injects caller when present', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'Dep0' })
			class Dep0 extends BasePlugin {}

			@Plugin({ name: 'Host0' })
			class Host0 extends BasePlugin {
				missing = false
				callerId: string | null = null

				read(): void {
					this.missing = this.features.dep(Dep0) === undefined
					const dep = this.features.dep(Dep0)
					this.callerId = dep?.ctx.caller?.pluginInfo?.id ?? null
				}

				override init(): void {
					this.read()
				}
			}

			host.add(Host0)
			await host.commit()

			const h0 = host.require(Host0) as Host0
			h0.read()
			expect(h0.missing).toBe(true)
			expect(h0.callerId).toBeNull()

			host.add(Dep0)
			await host.commit()

			h0.read()
			expect(h0.missing).toBe(false)
			expect(h0.callerId).toBe('Host0')
		})
	})

	it('invokes callbacks when dep appears and runs cleanup when dep disappears', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'Dep' })
			class Dep extends BasePlugin {}

			@Plugin({ name: 'Host' })
			class Host extends BasePlugin {
				seen = 0
				cleaned = 0

				override init(): void {
					this.features.dep(Dep, () => {
						this.seen++
						return () => {
							this.cleaned++
						}
					})
				}
			}

			host.add(Host)
			await host.commit()

			const h = host.require(Host) as Host
			expect(h.seen).toBe(0)
			expect(h.cleaned).toBe(0)

			host.add(Dep)
			await host.commit()
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(0)

			host.remove(Dep)
			await host.commit()
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(1)
		})
	})

	it('supports multiple callbacks for the same dep', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'DepMany' })
			class DepMany extends BasePlugin {}

			@Plugin({ name: 'HostMany' })
			class HostMany extends BasePlugin {
				aSeen = 0
				bSeen = 0
				aCleaned = 0
				bCleaned = 0

				override init(): void {
					this.features.dep(DepMany, () => {
						this.aSeen++
						return () => {
							this.aCleaned++
						}
					})
					this.features.dep(DepMany, () => {
						this.bSeen++
						return () => {
							this.bCleaned++
						}
					})
				}
			}

			host.add(HostMany)
			await host.commit()

			const h = host.require(HostMany) as HostMany
			expect(h.aSeen).toBe(0)
			expect(h.bSeen).toBe(0)

			host.add(DepMany)
			await host.commit()
			expect(h.aSeen).toBe(1)
			expect(h.bSeen).toBe(1)

			host.remove(DepMany)
			await host.commit()
			expect(h.aCleaned).toBe(1)
			expect(h.bCleaned).toBe(1)
		})
	})

	it('invokes callbacks immediately when subscribing after dep is already running', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'DepLate' })
			class DepLate extends BasePlugin {}

			@Plugin({ name: 'HostLate' })
			class HostLate extends BasePlugin {
				aSeen = 0
				bSeen = 0
				cleaned = 0

				offA?: () => void
				offB?: () => void

				watchA(): void {
					this.offA = this.features.dep(DepLate, () => {
						this.aSeen++
						return () => {
							this.cleaned++
						}
					})
				}

				watchB(): void {
					this.offB = this.features.dep(DepLate, () => {
						this.bSeen++
						return () => {
							this.cleaned++
						}
					})
				}
			}

			host.add([HostLate, DepLate])
			await host.commit()

			const h = host.require(HostLate) as HostLate
			expect(h.aSeen).toBe(0)
			expect(h.bSeen).toBe(0)
			expect(h.cleaned).toBe(0)

			h.watchA()
			expect(h.aSeen).toBe(1)
			expect(h.bSeen).toBe(0)
			expect(h.cleaned).toBe(0)

			h.watchB()
			expect(h.aSeen).toBe(1)
			expect(h.bSeen).toBe(1)
			expect(h.cleaned).toBe(0)

			h.offA?.()
			h.offB?.()
			expect(h.cleaned).toBe(2)

			host.restart(DepLate)
			await host.commit()
			expect(h.aSeen).toBe(1)
			expect(h.bSeen).toBe(1)
			expect(h.cleaned).toBe(2)
		})
	})

	it('returned unsubscribe stops future callbacks and runs cleanup once', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'DepOff' })
			class DepOff extends BasePlugin {}

			@Plugin({ name: 'HostOff' })
			class HostOff extends BasePlugin {
				seen = 0
				cleaned = 0
				off?: () => void

				override init(): void {
					this.off = this.features.dep(DepOff, () => {
						this.seen++
						return () => {
							this.cleaned++
						}
					})
				}
			}

			host.add([HostOff, DepOff])
			await host.commit()

			const h = host.require(HostOff) as HostOff
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(0)

			h.off?.()
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(1)

			host.restart(DepOff)
			await host.commit()
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(1)

			host.remove(DepOff)
			await host.commit()
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(1)
		})
	})

	it('does not run cleanup twice when dep disappears then unsubscribe is called', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'DepGone' })
			class DepGone extends BasePlugin {}

			@Plugin({ name: 'HostGone' })
			class HostGone extends BasePlugin {
				seen = 0
				cleaned = 0
				off?: () => void

				override init(): void {
					this.off = this.features.dep(DepGone, () => {
						this.seen++
						return () => {
							this.cleaned++
						}
					})
				}
			}

			host.add([HostGone, DepGone])
			await host.commit()

			const h = host.require(HostGone) as HostGone
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(0)

			host.remove(DepGone)
			await host.commit()
			expect(h.cleaned).toBe(1)

			h.off?.()
			expect(h.cleaned).toBe(1)
		})
	})

	it('auto-disposes dep subscriptions on plugin unload', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'DepDispose' })
			class DepDispose extends BasePlugin {}

			let cleaned = 0

			@Plugin({ name: 'HostDispose' })
			class HostDispose extends BasePlugin {
				override init(): void {
					this.features.dep(DepDispose, () => {
						return () => {
							cleaned++
						}
					})
				}
			}

			host.add([HostDispose, DepDispose])
			await host.commit()
			expect(cleaned).toBe(0)

			host.remove(HostDispose)
			await host.commit()
			expect(cleaned).toBe(1)
		})
	})

	it('re-invokes callback when dep instance changes', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'Dep2' })
			class Dep2 extends BasePlugin {}

			@Plugin({ name: 'Host2' })
			class Host2 extends BasePlugin {
				seen = 0
				cleaned = 0
				lastCallerId: string | null = null

				override init(): void {
					this.features.dep(Dep2, (dep) => {
						this.seen++
						this.lastCallerId = dep.ctx.caller?.pluginInfo?.id ?? null
						return () => {
							this.cleaned++
						}
					})
				}
			}

			host.add([Host2, Dep2])
			await host.commit()

			const h = host.require(Host2) as Host2
			expect(h.seen).toBe(1)
			expect(h.cleaned).toBe(0)
			expect(h.lastCallerId).toBe('Host2')

			host.restart(Dep2)
			await host.commit()

			expect(h.seen).toBe(2)
			expect(h.cleaned).toBe(1)
			expect(h.lastCallerId).toBe('Host2')
		})
	})

	it('does not expose deps that failed to start', async () => {
		await withHost(async (host) => {
			@Plugin({ name: 'DepFail' })
			class DepFail extends BasePlugin {
				override init(): void {
					throw new Error('fail')
				}
			}

			@Plugin({ name: 'HostFail' })
			class HostFail extends BasePlugin {
				seen = 0
				hasDep = false

				override init(): void {
					this.features.dep(DepFail, () => {
						this.seen++
					})
				}

				read(): void {
					this.hasDep = this.features.dep(DepFail) != null
				}
			}

			host.add(HostFail)
			await host.commit()

			const h = host.require(HostFail) as HostFail
			expect(h.seen).toBe(0)
			h.read()
			expect(h.hasDep).toBe(false)

			host.add(DepFail)
			const summary = await host.commitAllowFail()
			expect(summary.failed).toContain(DepFail)

			expect(h.seen).toBe(0)
			h.read()
			expect(h.hasDep).toBe(false)
		})
	})
})
