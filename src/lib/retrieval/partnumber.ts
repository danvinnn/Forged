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

  return [...variants].filter(Boolean);
}
