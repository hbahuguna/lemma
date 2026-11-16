/**
 * @lemma/cloud — Optional cloud-tier services (metering, quota, billing).
 *
 * See docs/architecture.md for the package graph and dependency direction.
 */
export const PACKAGE_NAME = "@lemma/cloud" as const;

export * from "./metering.js";
export * from "./auth.js";
