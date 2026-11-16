export const PACKAGE_NAME = "@lemma/pro" as const;

export {
  PRO_ENTITLEMENT_SCHEMA_VERSIONS,
  PRO_LEARN_MORE_URL,
  PRO_UNAVAILABLE_CODE,
  ProUnavailableError,
  invokeProCapability,
  isProLicensed,
  requireProLicense,
} from "./entitlement.js";

export type {
  ProEntitlementLike,
  ProEntitlementVerificationLike,
  ProLicenseContext,
  ProScopedAuthLike,
} from "./entitlement.js";

export * from "./commands/specialists.js";
export * from "./proof.js";
export * from "./proof/backends/index.js";
export * from "./inventory.js";
export * from "./quality-history.js";
export * from "./integrations/jira-xray.js";
export * from "./integrations/testrail.js";
export * from "./model-eval.js";
export * as evidence from "./revisions.js";
export { saveRevision, compareRevisions, listRevisions, validateRevisionDiff } from "./revisions.js";
