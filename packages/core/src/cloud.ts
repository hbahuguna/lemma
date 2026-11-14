/**
 * Optional cloud capability surface (contract/subpath).
 *
 * This subpath is optional and must not require cloud/provider SDKs for core installs.
 * Concrete cloud services live in @lemma/cloud (optional peer).
 */
export const CLOUD_SUBPATH = "@lemma/core/cloud" as const;
export const CLOUD_OPTIONAL = true as const;

export interface CloudCapabilityContract {
  readonly optional: true;
  readonly provider: "@lemma/cloud";
}
