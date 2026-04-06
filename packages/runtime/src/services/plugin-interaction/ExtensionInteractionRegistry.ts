import type { Context } from '@pluxel/core'
import type {
	BuiltinExtensionDef,
	ExtensionInteractionRecord,
	InteractionOfferDef,
	InteractionSessionDef,
	InteractionSurfaceDef,
} from '../../web/extensions'
import type { ExtensionPoint } from '../../web/ui'
import {
	assertSerializableValue,
	errorMessage,
	type RegisteredOffer,
	type RegisteredSurface,
	type ResolvedSessionCandidate,
	InteractionValidationError,
	isValidationError,
	normalizePrepareResult,
	stripRuntime,
} from './ExtensionService.shared'

export class ExtensionInteractionRegistry {
	private readonly builtinsByPlugin = new Map<string, Map<string, BuiltinExtensionDef>>()
	private readonly offersByPlugin = new Map<string, Map<string, RegisteredOffer>>()
	private readonly surfacesByPlugin = new Map<string, Map<string, RegisteredSurface>>()
	private readonly sessionDraftById = new Map<string, unknown>()
	private readonly sessionInputById = new Map<string, unknown>()
	private readonly warningSignatureByKey = new Map<string, string>()

	constructor(public ctx: Context) {}

	setContext(ctx: Context): void {
		this.ctx = ctx
	}

	addBuiltin(def: BuiltinExtensionDef): void {
		const pluginName = def.pluginName
		const key = `${String(def.point)}:${String(def.id)}`
		let bucket = this.builtinsByPlugin.get(pluginName)
		if (!bucket) {
			bucket = new Map()
			this.builtinsByPlugin.set(pluginName, bucket)
		}
		bucket.set(key, def)
	}

	removeBuiltin(def: BuiltinExtensionDef): boolean {
		const bucket = this.builtinsByPlugin.get(def.pluginName)
		if (!bucket) return false
		const key = `${String(def.point)}:${String(def.id)}`
		if (bucket.get(key) !== def) return false
		bucket.delete(key)
		if (bucket.size === 0) this.builtinsByPlugin.delete(def.pluginName)
		return true
	}

	addSurface(def: RegisteredSurface): void {
		let bucket = this.surfacesByPlugin.get(def.pluginName)
		if (!bucket) {
			bucket = new Map()
			this.surfacesByPlugin.set(def.pluginName, bucket)
		}
		bucket.set(this.getSurfaceKey(def.point, def.id), def)
	}

	removeSurface(def: RegisteredSurface): boolean {
		const bucket = this.surfacesByPlugin.get(def.pluginName)
		if (!bucket) return false
		const key = this.getSurfaceKey(def.point, def.id)
		if (bucket.get(key) !== def) return false
		bucket.delete(key)
		if (bucket.size === 0) this.surfacesByPlugin.delete(def.pluginName)
		return true
	}

	addOffer(def: RegisteredOffer): void {
		let bucket = this.offersByPlugin.get(def.pluginName)
		if (!bucket) {
			bucket = new Map()
			this.offersByPlugin.set(def.pluginName, bucket)
		}
		bucket.set(this.getOfferKey(def.point, def.id), def)
	}

	removeOffer(def: RegisteredOffer): boolean {
		const bucket = this.offersByPlugin.get(def.pluginName)
		if (!bucket) return false
		const key = this.getOfferKey(def.point, def.id)
		if (bucket.get(key) !== def) return false
		bucket.delete(key)
		if (bucket.size === 0) this.offersByPlugin.delete(def.pluginName)
		return true
	}

	clearPlugin(pluginName: string): void {
		this.offersByPlugin.delete(pluginName)
		this.surfacesByPlugin.delete(pluginName)
		this.builtinsByPlugin.delete(pluginName)
		this.clearSessionStateForPlugin(pluginName)
		this.clearWarningStateForPlugin(pluginName)
	}

	getSnapshot(): {
		builtins: BuiltinExtensionDef[]
		surfaces: InteractionSurfaceDef[]
		offers: InteractionOfferDef[]
		sessions: InteractionSessionDef[]
		interactions: ExtensionInteractionRecord[]
	} {
		const builtins: BuiltinExtensionDef[] = []
		for (const bucket of this.builtinsByPlugin.values()) {
			builtins.push(...bucket.values())
		}
		builtins.sort((a, b) => {
				const pluginDiff = a.pluginName.localeCompare(b.pluginName)
				if (pluginDiff !== 0) return pluginDiff
				const pointDiff = String(a.point).localeCompare(String(b.point))
				if (pointDiff !== 0) return pointDiff
				return String(a.id).localeCompare(String(b.id))
			})
		const surfaces = this.getSurfacesSnapshot()
		const offers = this.getOffersSnapshot()
		const interactions: ExtensionInteractionRecord[] = []
		const sessions: InteractionSessionDef[] = []
		const candidatesBySurface = new Map<string, ResolvedSessionCandidate[]>()

		for (const offer of offers) {
			const matchingSurfaces = surfaces.filter(
				(surface) =>
					String(surface.point) === String(offer.point) &&
					this.contractsMatch(surface.contract, offer.contract),
			)
			if (matchingSurfaces.length === 0) {
				interactions.push({
					point: offer.point,
					surface: undefined,
					offerId: offer.id,
					providerPlugin: offer.pluginName,
					priority: offer.priority ?? 0,
					contract: offer.contract,
					state: 'waiting-surface',
					reason: 'surface_not_found',
				})
				continue
			}

			for (const surface of matchingSurfaces) {
				const baseRecord: ExtensionInteractionRecord = {
					targetPlugin: surface.pluginName,
					surface: surface.id,
					point: surface.point,
					offerId: offer.id,
					providerPlugin: offer.pluginName,
					priority: offer.priority ?? 0,
					contract: surface.contract,
					state: 'active',
				}
				if (Array.isArray(offer.targets) && !offer.targets.includes(surface.pluginName)) {
					interactions.push({
						...baseRecord,
						state: 'rejected',
						reason: 'target_not_allowed',
					})
					continue
				}
				if (Array.isArray(surface.providers) && !surface.providers.includes(offer.pluginName)) {
					interactions.push({
						...baseRecord,
						state: 'rejected',
						reason: 'provider_not_allowed',
					})
					continue
				}
				if (!this.targetDependsOnProvider(surface.pluginName, offer.pluginName)) {
					interactions.push({
						...baseRecord,
						state: 'rejected',
						reason: 'dependency_not_satisfied',
					})
					continue
				}

				const session: InteractionSessionDef = {
					id: this.createSessionId(surface, offer),
					point: surface.point,
					pluginName: surface.pluginName,
					providerPluginName: offer.pluginName,
					offerId: offer.id,
					surfaceId: surface.id,
					contract: surface.contract,
					renderKey: offer.renderKey,
					priority: offer.priority,
					requireRunning: offer.requireRunning,
					meta: surface.meta,
				}
				const key = `${surface.pluginName}\u0000${surface.id}`
				const bucket = candidatesBySurface.get(key)
				const candidate = { session, record: baseRecord }
				if (bucket) bucket.push(candidate)
				else candidatesBySurface.set(key, [candidate])
			}
		}

		for (const surface of surfaces) {
			const key = `${surface.pluginName}\u0000${surface.id}`
			const bucket = candidatesBySurface.get(key) ?? []
			const sorted = [...bucket].sort((a, b) => this.compareSessionCandidates(a, b))
			if (sorted.length > 1 && surface.cardinality !== 'multiple') {
				this.warnOnce(
					`surface-conflict:${surface.pluginName}:${surface.id}`,
					sorted
						.map((item) => `${item.record.providerPlugin ?? ''}:${item.record.offerId}`)
						.join('|'),
					'multiple offers matched a single interaction surface; using the highest priority offer',
					{
						targetPlugin: surface.pluginName,
						surface: surface.id,
						candidates: sorted.map((item) => ({
							offerId: item.record.offerId,
							providerPlugin: item.record.providerPlugin,
							priority: item.record.priority,
						})),
					},
				)
			}

			if (surface.cardinality === 'multiple') {
				for (const item of sorted) {
					sessions.push(item.session)
					interactions.push({ ...item.record, state: 'active' })
				}
			} else {
				const selected = sorted[0]
				if (selected) {
					sessions.push(selected.session)
					interactions.push({ ...selected.record, state: 'active' })
				}
				for (const item of sorted.slice(1)) {
					interactions.push({
						...item.record,
						state: 'rejected',
						reason: 'shadowed_by_higher_priority',
					})
				}
			}

			if (
				surface.required === true &&
				!interactions.some(
					(item) =>
						item.targetPlugin === surface.pluginName &&
						item.surface === surface.id &&
						item.state === 'active',
				)
			) {
				this.warnOnce(
					`surface-required:${surface.pluginName}:${surface.id}`,
					'required',
					'required interaction surface has no active offer',
					{
						targetPlugin: surface.pluginName,
						surface: surface.id,
						point: surface.point,
					},
				)
				interactions.push({
					targetPlugin: surface.pluginName,
					surface: surface.id,
					point: surface.point,
					offerId: `${surface.pluginName}:${surface.id}:required`,
					providerPlugin: undefined,
					priority: 0,
					contract: surface.contract,
					state: 'waiting-provider',
					reason: 'required_surface_unfulfilled',
				})
			}
		}

		sessions.sort((a, b) => {
			const pluginDiff = a.pluginName.localeCompare(b.pluginName)
			if (pluginDiff !== 0) return pluginDiff
			const pointDiff = String(a.point).localeCompare(String(b.point))
			if (pointDiff !== 0) return pointDiff
			return String(a.id).localeCompare(String(b.id))
		})
		interactions.sort((a, b) => {
			const targetDiff = String(a.targetPlugin ?? '').localeCompare(String(b.targetPlugin ?? ''))
			if (targetDiff !== 0) return targetDiff
			const surfaceDiff = String(a.surface ?? '').localeCompare(String(b.surface ?? ''))
			if (surfaceDiff !== 0) return surfaceDiff
			const stateDiff = a.state.localeCompare(b.state)
			if (stateDiff !== 0) return stateDiff
			const providerDiff = String(a.providerPlugin ?? '').localeCompare(
				String(b.providerPlugin ?? ''),
			)
			if (providerDiff !== 0) return providerDiff
			return a.offerId.localeCompare(b.offerId)
		})

		return { builtins, surfaces, offers, sessions, interactions }
	}

	async loadSession(sessionId: string): Promise<
		| {
				ok: true
				input: unknown
				draft: unknown
				prepared: unknown
		  }
		| {
				ok: false
				code:
					| 'session_not_found'
					| 'surface_not_found'
					| 'offer_not_found'
					| 'prepare_failed'
					| 'validation_failed'
				message?: string
		  }
	> {
		const resolved = this.resolveSessionRuntime(sessionId)
		if (!resolved) {
			return { ok: false, code: 'session_not_found', message: 'Interaction session not found.' }
		}

		const { session, surface, offer } = resolved
		const inputValue = await this.loadSurfaceInput(surface, session)
		const currentDraft = this.sessionDraftById.get(sessionId)
		const controller = new AbortController()

		try {
			const prepared = offer.runtime.prepare
				? await offer.runtime.prepare({
						sessionId,
						targetPlugin: session.pluginName,
						providerPlugin: session.providerPluginName,
						surfaceId: session.surfaceId,
						offerId: session.offerId,
						contract: session.contract,
						input: inputValue,
						signal: controller.signal,
					})
				: undefined
			const normalizedPrepare = normalizePrepareResult(prepared)
			const draftValue =
				currentDraft !== undefined
					? currentDraft
					: normalizedPrepare.draft !== undefined
						? normalizedPrepare.draft
						: null
			const validatedDraft = this.validateDraft(surface, draftValue)
			this.sessionDraftById.set(sessionId, validatedDraft)
			this.sessionInputById.set(sessionId, inputValue)
			assertSerializableValue('offer.prepare.prepared', normalizedPrepare.prepared)
			return {
				ok: true,
				input: inputValue,
				draft: validatedDraft,
				prepared: normalizedPrepare.prepared ?? null,
			}
		} catch (error) {
			return {
				ok: false,
				code: isValidationError(error) ? 'validation_failed' : 'prepare_failed',
				message: errorMessage(error),
			}
		}
	}

	async syncDraft(input: { sessionId: string; draft: unknown }): Promise<
		| {
				ok: true
		  }
		| {
				ok: false
				code:
					| 'session_not_found'
					| 'surface_not_found'
					| 'offer_not_found'
					| 'validation_failed'
					| 'apply_failed'
				message?: string
		  }
	> {
		const resolved = this.resolveSessionRuntime(String(input?.sessionId ?? '').trim())
		if (!resolved) {
			return { ok: false, code: 'session_not_found', message: 'Interaction session not found.' }
		}

		const { session, surface, offer } = resolved
		try {
			const validatedDraft = this.validateDraft(surface, input?.draft)
			this.sessionDraftById.set(session.id, validatedDraft)
			const currentInput = await this.ensureSessionInput(surface, session)
			if (surface.runtime.onDraftChange) {
				await surface.runtime.onDraftChange(validatedDraft, {
					sessionId: session.id,
					targetPlugin: session.pluginName,
					providerPlugin: session.providerPluginName,
					surfaceId: session.surfaceId,
					offerId: session.offerId,
					contract: session.contract,
					input: currentInput,
				})
			}
			void offer
			return { ok: true }
		} catch (error) {
			return {
				ok: false,
				code: isValidationError(error) ? 'validation_failed' : 'apply_failed',
				message: errorMessage(error),
			}
		}
	}

	async commitSession(input: { sessionId: string; result: unknown }): Promise<
		| {
				ok: true
		  }
		| {
				ok: false
				code:
					| 'session_not_found'
					| 'surface_not_found'
					| 'offer_not_found'
					| 'validation_failed'
					| 'apply_failed'
				message?: string
		  }
	> {
		const resolved = this.resolveSessionRuntime(String(input?.sessionId ?? '').trim())
		if (!resolved) {
			return { ok: false, code: 'session_not_found', message: 'Interaction session not found.' }
		}

		const { session, surface } = resolved
		try {
			const currentInput = await this.ensureSessionInput(surface, session)
			const currentDraft = this.sessionDraftById.get(session.id) ?? null
			const validatedResult = this.validateResult(surface, input?.result)
			await surface.runtime.apply(validatedResult, {
				sessionId: session.id,
				targetPlugin: session.pluginName,
				providerPlugin: session.providerPluginName,
				surfaceId: session.surfaceId,
				offerId: session.offerId,
				contract: session.contract,
				input: currentInput,
				draft: currentDraft,
			})
			this.sessionDraftById.delete(session.id)
			this.sessionInputById.delete(session.id)
			return { ok: true }
		} catch (error) {
			return {
				ok: false,
				code: isValidationError(error) ? 'validation_failed' : 'apply_failed',
				message: errorMessage(error),
			}
		}
	}

	private getSurfaceKey(point: ExtensionPoint, id: string): string {
		return `${String(point)}:${String(id)}`
	}

	private getOfferKey(point: ExtensionPoint, id: string): string {
		return `${String(point)}:${String(id)}`
	}

	private getSurfacesSnapshot(): InteractionSurfaceDef[] {
		const surfaces: InteractionSurfaceDef[] = []
		for (const bucket of this.surfacesByPlugin.values()) {
			for (const def of bucket.values()) surfaces.push(stripRuntime(def))
		}
		surfaces.sort((a, b) => {
			const pluginDiff = a.pluginName.localeCompare(b.pluginName)
			if (pluginDiff !== 0) return pluginDiff
			const pointDiff = String(a.point).localeCompare(String(b.point))
			if (pointDiff !== 0) return pointDiff
			return String(a.id).localeCompare(String(b.id))
		})
		return surfaces
	}

	private getOffersSnapshot(): InteractionOfferDef[] {
		const offers: InteractionOfferDef[] = []
		for (const bucket of this.offersByPlugin.values()) {
			for (const def of bucket.values()) offers.push(stripRuntime(def))
		}
		offers.sort((a, b) => {
			const pluginDiff = a.pluginName.localeCompare(b.pluginName)
			if (pluginDiff !== 0) return pluginDiff
			const pointDiff = String(a.point).localeCompare(String(b.point))
			if (pointDiff !== 0) return pointDiff
			return String(a.id).localeCompare(String(b.id))
		})
		return offers
	}

	private contractsMatch(
		left: InteractionSurfaceDef['contract'],
		right: InteractionOfferDef['contract'],
	): boolean {
		return String(left.id) === String(right.id) && Number(left.version) === Number(right.version)
	}

	private createSessionId(surface: InteractionSurfaceDef, offer: InteractionOfferDef): string {
		return `${surface.pluginName}:${surface.id}<-${offer.pluginName}:${offer.id}`
	}

	private resolveSessionRuntime(
		sessionId: string,
	): { session: InteractionSessionDef; surface: RegisteredSurface; offer: RegisteredOffer } | null {
		const resolved = this.getSnapshot()
		const session = resolved.sessions.find((item) => item.id === sessionId)
		if (!session) return null
		const surface =
			this.surfacesByPlugin
				.get(session.pluginName)
				?.get(this.getSurfaceKey(session.point, session.surfaceId)) ?? null
		if (!surface) return null
		const offer =
			this.offersByPlugin
				.get(session.providerPluginName)
				?.get(this.getOfferKey(session.point, session.offerId)) ?? null
		if (!offer) return null
		return { session, surface, offer }
	}

	private async loadSurfaceInput(
		surface: RegisteredSurface,
		session: InteractionSessionDef,
	): Promise<unknown> {
		const rawInput = surface.runtime.input ? await surface.runtime.input() : null
		const validated = this.runValidation(
			() =>
				typeof surface.runtime.contract.validateInput === 'function'
					? surface.runtime.contract.validateInput(rawInput)
					: rawInput,
			'surface input validation failed',
		)
		this.sessionInputById.set(session.id, validated)
		return validated
	}

	private validateDraft(surface: RegisteredSurface, draft: unknown): unknown {
		assertSerializableValue('interaction draft', draft)
		return this.runValidation(
			() =>
				typeof surface.runtime.contract.validateDraft === 'function'
					? surface.runtime.contract.validateDraft(draft)
					: draft,
			'interaction draft validation failed',
		)
	}

	private validateResult(surface: RegisteredSurface, result: unknown): unknown {
		assertSerializableValue('interaction result', result)
		return this.runValidation(
			() =>
				typeof surface.runtime.contract.validateResult === 'function'
					? surface.runtime.contract.validateResult(result)
					: result,
			'interaction result validation failed',
		)
	}

	private async ensureSessionInput(
		surface: RegisteredSurface,
		session: InteractionSessionDef,
	): Promise<unknown> {
		if (this.sessionInputById.has(session.id)) return this.sessionInputById.get(session.id)
		return await this.loadSurfaceInput(surface, session)
	}

	private clearSessionStateForPlugin(pluginName: string): void {
		const draftKeys = [...this.sessionDraftById.keys()]
		for (const key of draftKeys) {
			if (key.includes(`${pluginName}:`) || key.includes(`<-${pluginName}:`)) {
				this.sessionDraftById.delete(key)
			}
		}
		const inputKeys = [...this.sessionInputById.keys()]
		for (const key of inputKeys) {
			if (key.includes(`${pluginName}:`) || key.includes(`<-${pluginName}:`)) {
				this.sessionInputById.delete(key)
			}
		}
	}

	private runValidation<T>(runner: () => T, message: string): T {
		try {
			return runner()
		} catch (error) {
			throw new InteractionValidationError(message, error)
		}
	}

	private warnOnce(
		key: string,
		signature: string,
		message: string,
		meta?: Record<string, unknown>,
	): void {
		if (this.warningSignatureByKey.get(key) === signature) return
		this.warningSignatureByKey.set(key, signature)
		this.ctx.logger.warn(message, meta ?? {})
	}

	private clearWarningStateForPlugin(pluginName: string): void {
		const warningKeys = [...this.warningSignatureByKey.keys()]
		for (const key of warningKeys) {
			if (key.includes(`:${pluginName}:`)) this.warningSignatureByKey.delete(key)
		}
	}

	private compareSessionCandidates(
		a: ResolvedSessionCandidate,
		b: ResolvedSessionCandidate,
	): number {
		const priorityDiff = (b.record.priority ?? 0) - (a.record.priority ?? 0)
		if (priorityDiff !== 0) return priorityDiff
		const sourceA = String(a.record.providerPlugin ?? '').trim()
		const sourceB = String(b.record.providerPlugin ?? '').trim()
		const sourceDiff = sourceA.localeCompare(sourceB)
		if (sourceDiff !== 0) return sourceDiff
		return String(a.record.offerId).localeCompare(String(b.record.offerId))
	}

	private targetDependsOnProvider(targetPluginName: string, providerPluginName: string): boolean {
		if (!targetPluginName || !providerPluginName) return false
		if (targetPluginName === providerPluginName) return true

		const loaderApi = this.ctx.loader?.api
		const targetCtor =
			loaderApi?.runtime?.resolve?.(targetPluginName) ??
			loaderApi?.registry?.getCtor?.(targetPluginName)
		if (!targetCtor) return false
		const deps = loaderApi?.deps?.list?.(targetCtor)
		if (!Array.isArray(deps)) return false
		return deps.some((dep) => dep?.name === providerPluginName)
	}
}
