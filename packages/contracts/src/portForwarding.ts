import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ForwardedPortNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65535 }),
);
export const ForwardedPort = Schema.Struct({
  port: ForwardedPortNumber,
  protocol: Schema.Literals(["http", "https"]),
  previewUrl: TrimmedNonEmptyString,
});
export type ForwardedPort = typeof ForwardedPort.Type;

export const PortForwardInput = Schema.Union([
  Schema.TaggedStruct("start", {
    port: ForwardedPortNumber,
    protocol: Schema.Literals(["http", "https"]),
  }),
  Schema.TaggedStruct("stop", { port: ForwardedPortNumber }),
  Schema.TaggedStruct("open", { port: ForwardedPortNumber }),
]);
export type PortForwardInput = typeof PortForwardInput.Type;

export const PortForwardSnapshot = Schema.Struct({
  forwards: Schema.Array(ForwardedPort),
  reservedPorts: Schema.Array(ForwardedPortNumber),
  mode: Schema.Literal("local"),
});
export type PortForwardSnapshot = typeof PortForwardSnapshot.Type;

export const PortForwardResult = Schema.Struct({
  ...PortForwardSnapshot.fields,
  openUrl: Schema.optional(TrimmedNonEmptyString),
});
export type PortForwardResult = typeof PortForwardResult.Type;

export class PortForwardError extends Schema.TaggedErrorClass<PortForwardError>()(
  "PortForwardError",
  {
    message: Schema.String,
  },
) {}
