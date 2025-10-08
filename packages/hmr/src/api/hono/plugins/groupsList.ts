import { vValidator } from '@hono/valibot-validator'
import { Hono } from 'hono'
import * as v from 'valibot'
import type { AppEnv } from '../../../services/hono/env'

const updateGroupsSchema = v.array(
	v.object({
		groupId: v.string(),
		name: v.string(),
		pluginIds: v.array(v.string()),
	}),
)

type UpdateGroupsPayload = v.InferOutput<typeof updateGroupsSchema>

export const groupsList = new Hono<AppEnv>()
	.get('/', (c) => {
		const ctx = c.var.plugin_ctx
		const data = ctx.configService.getExtra('groups') ?? []
		return c.json<UpdateGroupsPayload>(data, 200)
	})
	.post('/', vValidator('json', updateGroupsSchema), (c) => {
		const inputData: UpdateGroupsPayload = c.req.valid('json')
		const ctx = c.var.plugin_ctx
		ctx.configService.setExtra('groups', inputData)

		return c.json<UpdateGroupsPayload>(inputData, 200)
	})
