// Decoy: a similarly named, CORRECT module. Computes how many pages a list of
// `total` items spans at the given page `size`. This file is fine — do not edit it.
export function pageCount(total, size) {
  return Math.ceil(total / size);
}
