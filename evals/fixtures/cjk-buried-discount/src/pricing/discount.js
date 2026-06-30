// Applies a percentage discount to a price.
// BUG: the discounted price should be lower than the original, but the sign is
// wrong — it ADDS the percentage instead of subtracting it.
export function applyDiscount(price, percentOff) {
  return price * (1 + percentOff / 100);
}
