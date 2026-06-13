"use strict";

/**
 * TRANSFORM stage: apply a discount and round the price to cents.
 *
 * BUG LIVES HERE. The price is meant to be discounted by `rate` (e.g. 0.1 =
 * 10% off) and rounded to 2 decimals. The output stage and the parser are
 * both correct — fix the math in this transform, not the renderer.
 */
function normalize(record, rate) {
  const discounted = record.price * rate; // wrong: this keeps only the discount amount
  return { name: record.name, price: Math.round(discounted * 100) / 100 };
}

module.exports = { normalize };
