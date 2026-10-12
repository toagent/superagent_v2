export const TIERS = ['commander', 'general', 'strategist'] as const;
export type Tier = (typeof TIERS)[number];
export const ROUTE_ROLE = { commander: 'command', general: 'code', strategist: 'review' } as const;
export const isTier = (v: unknown): v is Tier => TIERS.includes(v as Tier);
