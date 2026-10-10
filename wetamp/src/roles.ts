export const TIERS = ['commander', 'general', 'strategist'] as const;
export type Tier = (typeof TIERS)[number];
export const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier);
