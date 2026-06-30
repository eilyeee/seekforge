// Computes the amount due at checkout: line items minus an order-level discount.
// BUG: the discount is ADDED instead of subtracted, so the total is too high
// (3 items at 10 with a 10% discount should be 27, not 33).
export function computeCheckoutTotal(items, discountRate) {
  const subtotal = items.reduce((sum, it) => sum + it.price * it.qty, 0);
  return subtotal * (1 + discountRate);
}
