// Decoy: a similarly named, CORRECT module. Maps a tier name to its discount
// percentage. This file is fine and must not be edited.
const TIERS = { bronze: 5, silver: 10, gold: 20 };

export function discountForTier(tier) {
  return TIERS[tier] ?? 0;
}
