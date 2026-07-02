# Host Access

实现入口：

- `packages/runtime/src/services/verification/VerificationService.ts`
- `packages/runtime/src/services/vault/VaultService.ts`
- `packages/runtime/src/services/vault.ts`
  显式 vault boundary，导出 host bootstrap helper；内部实现落在 `services/security/bootstrap.ts`
- `packages/runtime/src/api/http/security.ts`
- `packages/components/src/app/security/SecurityScreen.tsx`

## 核心原则

- verification 只回答 host control-plane / management 是否允许访问
- Pluxel 不保存本地账号、密码、OTP secret 或 passkey credential
- `management.enabled=false` 不挂 runtime web management，不要求 OIDC
- `management.enabled=true` 且 `management.access.exposure='private'` 不要求 OIDC
- `management.enabled=true` 且 `management.access.exposure='public'` 必须配置 OIDC，否则 fail fast
- OIDC 可以预先保留在 private/disabled 配置里，供后续切 public 使用
- listen/bind host 属于 launcher/deployment concern，不作为 runtime access policy 的唯一事实来源
- vault 只负责加密落盘，和 OIDC 身份验证解耦
- `data/security/identity.json` 只保存 vault host identity 和 deploy recipients

## 核心接口

- `ctx.root.verification`
  `authorize()` / `describe()`
- `ctx.vault`
  `kv()` / `docs()` / `blobs()` / `namespace()` / `flush()`
- `ctx.root.vaultAdmin`
  `preflight()` / `describe()` / `unlock()` / `rekey()` / `ensureHostKey()` / `generateDeployKey()` / `setDeployRecipients()`
- host 启动引导 helper
  `bootstrapHostVault(ctx)`
- `/security`
  对应专用 security client
  `readOverview()` / `listEvents()`
  `vault.unlock()` / `vault.ensureHostKey()` / `vault.generateDeployKey()` / `vault.setDeployRecipients()`

## 状态模型

- verification
  `exposure: 'private' | 'public'`
  `provider: 'none' | 'oidc'`
  `allow: boolean`
  `reason?: 'private' | 'missing_oidc' | 'unauthenticated' | 'invalid_token' | 'forbidden'`
  `principal?: { subject, claims }`
- vault
  `present` / `unlocked` / `unlockedBy` / `lastError` / `deploy` / `hostIdentityPresent` / `namespaces`

## Host 启动约束

- management public access 必须在 HTTP 服务初始化时通过 OIDC 配置校验
- Vault 只有一个启用入口：显式 import `@pluxel/runtime/services/vault`
- 启用 vault 的 host 在插件运行前调用 `bootstrapHostVault(ctx)`；static kernel 和 dynamic
  HMR host 都不默认 bootstrap vault
- `bootstrapHostVault(ctx)` 的顺序必须保持：
  `describe()` -> 仅在 mount 缺失且 host identity 缺失时 `ensureHostKey()` -> `preflight()`
- mount 不存在时直接通过
- mount 已存在且可解锁时通过
- mount 已存在但当前材料无法解锁时终止启动
