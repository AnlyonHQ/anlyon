import { KNOWN_VENDORS, type KnownVendor, publisherVerdict } from "@anlyon/known-vendors";

export { CHECKED_ON, KNOWN_VENDORS, type KnownVendor } from "@anlyon/known-vendors";

let added: readonly KnownVendor[] = [];

export function knownVendors(): readonly KnownVendor[] {
  return added.length === 0 ? KNOWN_VENDORS : [...KNOWN_VENDORS, ...added];
}

export function addKnownVendor(vendor: KnownVendor): void {
  if (knownVendors().some((known) => known.slug === vendor.slug)) throw new Error(`A vendor with the slug ${vendor.slug} is already known`);
  const verdict = publisherVerdict(vendor);
  if (!verdict.verified) throw new Error(`Vendor ${vendor.slug} fails its own check: ${verdict.reason}`);
  added = [...added, vendor];
}

export function resetAddedVendors(): void {
  added = [];
}
