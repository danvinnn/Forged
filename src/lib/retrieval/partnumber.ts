// Part-number normalization shared by the resolvers. Pure string manipulation.
//
// Air-gap safety: no network, no imports that reach the network.

export function normalizePartNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

// Manufacturers publish a datasheet per family, but users type ordering part numbers that carry
// package, temperature, and screening suffixes. LMP7704-SP is the family; 5962R1920601VXC is an
// orderable variant of the same die. We try progressively broader forms so a suffix does not cause
// a miss. Order matters: most specific first, so an exact hit wins before a broader guess.
export function buildPartVariants(partNumber: string): string[] {
  const normalized = normalizePartNumber(partNumber);
  const variants = new Set<string>([normalized]);

  // Drop a package/ordering suffix after a separator: LMP7704-SP -> LMP7704.
  variants.add(normalized.replace(/[-_].*$/, ""));

  // Drop a trailing option code after a numeric family: INA240A1 -> INA240.
  variants.add(normalized.replace(/(.*\d)[A-Z]+\d*$/, "$1"));

  // Drop a two-digit ordering tail: TPS7A4700 -> TPS7A47, TPS7A4901 -> TPS7A49.
  //
  // TI files these families under the STEM. `tps7a4700.pdf` was a valid
  // literature name once and is not any more: it now redirects to a product
  // category page, while `tps7a47.pdf` serves the datasheet whose first line
  // reads "TPS7A4700, TPS7A4701". Without this, both parts fall through the
  // constructed URLs into search, and search returned a DIFFERENT TPS7A part's
  // datasheet - which is how three wrong documents got into the corpus caches.
  //
  // Verified on those two parts only, so it is a guess elsewhere. It is a SAFE
  // guess for two reasons: it is added last, so an exact literature name always
  // wins, and `documentNamesPart` now rejects any candidate whose front matter
  // does not name the requested part, so a stem that lands on the wrong family
  // costs one wasted request rather than a wrong datasheet.
  //
  // Bounded so it cannot chew into a short name: LM358 must never become LM3.
  const stem = normalized.replace(/\d{2}$/, "");
  if (stem !== normalized && stem.length >= 5 && /\d$/.test(stem)) variants.add(stem);

  return [...variants].filter(Boolean);
}
