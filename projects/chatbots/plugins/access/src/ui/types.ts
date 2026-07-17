import type { PermissionGrant } from '../model.ts'

export type UserAccess = { roles: string[]; grants: PermissionGrant[] }
