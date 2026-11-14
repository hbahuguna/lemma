import { z } from "zod";

export const IsoTimestampSchema = z.string().min(1);
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const NonEmptyStringSchema = z.string().min(1);
export type NonEmptyString = z.infer<typeof NonEmptyStringSchema>;

export const JsonObjectSchema = z.record(z.unknown());
export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const SchemaVersionSchema = z.string().min(1);
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
