# Host Security

实现入口：

- `packages/runtime/src/services/verification/VerificationService.ts`
- `packages/runtime/src/services/vault/VaultService.ts`
- `packages/runtime/src/services/security/identity.ts`
- `packages/runtime/src/api/http/security.ts`
- `packages/components/src/app/security/SecurityScreen.tsx`

## 核心原则

- verification 只回答 host gate
- vault 只负责加密落盘
- host 持有会话、凭据、密钥材料和放行逻辑
- OTP/TOTP 计算交给 `otpauth`，passkey 协议校验交给 `@simplewebauthn/server`
- 长期安全材料只落在 `data/security/identity.json`
- `ctx.vault` 只保留存储面，`ctx.root.vaultAdmin` 只保留 host 管理面
- security 管理不进入 plugin control-plane，也不进入未来外部 tool surface

## 核心接口

- `ctx.root.verification`
  `authorize()` / `clear()` / `describe()` / `setMode()` / `setMethod()` / `deleteUser()`
  `verifyPassword()` / `verifyOtp()`
  `beginPasskeyRegistration()` / `finishPasskeyRegistration()`
  `beginPasskeyAuthentication()` / `finishPasskeyAuthentication()`
  `upsertPasswordUser()` / `provisionOtpUser()`
- gate、凭据都来自 `data/security/identity.json`
- `ctx.vault`
  `kv()` / `docs()` / `blobs()` / `namespace()` / `flush()`
- `ctx.root.vaultAdmin`
  `preflight()` / `describe()` / `unlock()` / `rekey()` / `ensureHostKey()` / `generateDeployKey()` / `setDeployRecipients()`
- host 启动引导 helper
  `bootstrapHostVault(ctx)`
- `/security`
  对应专用 security client
  `read()`
  `verification.clear()` / `verification.setMode()` / `verification.setMethod()`
  `verification.upsertPasswordUser()` / `verification.provisionOtpUser()` / `verification.deleteUser()`
  `verification.beginPasskeyRegistration()` / `verification.finishPasskeyRegistration()`
  `vault.unlock()` / `vault.ensureHostKey()` / `vault.generateDeployKey()` / `vault.setDeployRecipients()`

## 状态模型

- verification
  `mode: 'enforce' | 'bypass'`
  `method: 'password' | 'otp' | 'passkey'`
  `allow: boolean`
  `reason?: 'bypass' | 'verification_required' | 'misconfigured'`
  `users: Array<{ username }>`
- vault
  `present` / `unlocked` / `unlockedBy` / `lastError` / `deploy` / `hostIdentityPresent` / `namespaces`

## 引导约束

- 当 `verification.reason === 'misconfigured'` 时，只放行 `/security` 对应的 host 管理 API
- 凭据写入后，security API 立即回到正常 gate 约束

## Host 启动约束

- host 在插件激活前调用 `bootstrapHostVault(ctx)`
- `bootstrapHostVault(ctx)` 内部顺序：
  `describe()` -> 仅在 mount 缺失且 host key 缺失时 `ensureHostKey()` -> `preflight()`
- mount 不存在时直接通过
- mount 已存在且可解锁时通过
- mount 已存在但当前材料无法解锁时终止启动
