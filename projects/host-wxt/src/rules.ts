export const ruleDefaults = { tracking: true, fragment: false } as const
export type RuleKey = keyof typeof ruleDefaults
export const ruleKeys = Object.keys(ruleDefaults) as RuleKey[]
