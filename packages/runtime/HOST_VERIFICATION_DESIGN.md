# Host Access

实现入口：

- `packages/runtime/src/services/verification/VerificationService.ts`
- `packages/runtime/src/services/vault/VaultService.ts`
- `packages/runtime/src/services/security/identity.ts`
- `packages/runtime/src/api/http/security.ts`
- `packages/components/src/app/security/SecurityScreen.tsx`

## 核心原则

- verification 只回答 host control-plane 是否允许访问
- Pluxel 不保存本地账号、密码、OTP secret 或 passkey credential
- private mode 不做任何认证
- public mode 必须配置 OIDC，并通过 JWT issuer/JWKS 校验访问者身份
- host 绑定公网地址前必须调用 `verification.assertCanBindHost(host)`
- vault 只负责加密落盘，和 OIDC 身份验证解耦
- `data/security/identity.json` 只保存 vault host identity 和 deploy recipients

## 核心接口

- `ctx.root.verification`
  `authorize()` / `describe()` / `assertCanBindHost()`
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

- host 在插件运行前调用 `bootstrapHostVault(ctx)`
- `bootstrapHostVault(ctx)` 的顺序必须保持：
  `describe()` -> 仅在 mount 缺失且 host identity 缺失时 `ensureHostKey()` -> `preflight()`
- mount 不存在时直接通过
- mount 已存在且可解锁时通过
- mount 已存在但当前材料无法解锁时终止启动
