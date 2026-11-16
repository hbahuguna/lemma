// Parsers/serializers for durable test-intent formats (LEM-171).
// Core implementation lives in ../test-intent.ts; this module exists to
// provide the documented parser module boundary and stable import surface.
export {
  type TestIntentAction,
  type TestIntentFormat,
  type ManageTestsParams,
  type ManageTestsResult,
  type TestIntent,
  manageTests,
} from "../test-intent.js";
