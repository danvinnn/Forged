import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { normalizeOutlineCode, packageCodeOf, familyToken, spellOut, declaredLeadCount } from "../../src/lib/packagevariants";
for (const n of ["SMD5C", "Flat-16P"]) {
  console.log(n, "code=", packageCodeOf(n), "family=", familyToken(spellOut(n)), "declared=", declaredLeadCount(n));
}
console.log("normalizeOutlineCode 7924296_E =", normalizeOutlineCode("7924296_E"));
