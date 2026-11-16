/**
 * @lemma/cloud — Optional cloud-tier services (metering, quota, billing).
 *
 * See docs/architecture.md for the package graph and dependency direction.
 */
export const PACKAGE_NAME = "@lemma/cloud" as const;

export * from "./metering.js";
export * from "./auth.js";
export * from "./quota.js";
export * from "./ledger.js";
export * from "./signup.js";
export * from "./billing.js";
export * from "./queue.js";
export {
  RETENTION_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_GRACE_DAYS,
  DEFAULT_EXPORTS,
  DEFAULT_DELETION_AUDIT,
  DEFAULT_SIGNING_KEY,
  RetentionStore,
  TenantRetentionStore,
  TenantExporter,
  TenantDeletion,
  RetentionManager,
} from "./retention.js";
export * as entitlements from "./entitlements.js";
