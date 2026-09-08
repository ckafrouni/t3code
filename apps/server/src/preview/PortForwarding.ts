import {
  PortForwardError,
  type PortForwardInput,
  type PortForwardResult,
  type PortForwardSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { LocalPortForwards } from "./LocalPortForwards.ts";

const isPortForwardError = Schema.is(PortForwardError);

export class PortForwarding extends Context.Service<
  PortForwarding,
  {
    readonly execute: (
      input: PortForwardInput,
      owner: string,
      expiresAt?: number,
    ) => Effect.Effect<PortForwardResult, PortForwardError>;
    readonly snapshots: Stream.Stream<PortForwardSnapshot>;
  }
>()("t3/preview/PortForwarding") {}

export const layer = Layer.effect(
  PortForwarding,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sessions = yield* SessionStore;
    const manager = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new LocalPortForwards({
            reservedPorts: [
              config.port,
              ...(config.devUrl?.port ? [Number(config.devUrl.port)] : []),
            ],
            privateCookieNames: [
              sessions.cookieName,
              ...(sessions.legacyCookieName ? [sessions.legacyCookieName] : []),
            ],
          }),
      ),
      (value) => Effect.promise(() => value.close()),
    );
    const lock = yield* Semaphore.make(1);
    yield* sessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        Effect.sync(() => {
          if (change.type === "clientRemoved") manager.revokeOwner(change.sessionId);
        }),
      ),
      Effect.forkScoped,
    );
    return {
      execute: (input, owner, expiresAt) =>
        lock.withPermit(
          Effect.tryPromise({
            try: async () => {
              switch (input._tag) {
                case "start":
                  return manager.start(input.port, input.protocol);
                case "stop":
                  return manager.stop(input.port);
                case "open":
                  return manager.open(input.port, owner, expiresAt);
              }
            },
            catch: (error) =>
              isPortForwardError(error)
                ? error
                : new PortForwardError({
                    message:
                      "Could not update port forwarding. Check that a local preview listener can be started.",
                  }),
          }),
        ),
      snapshots: Stream.callback<PortForwardSnapshot>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() =>
            manager.subscribe((snapshot) => {
              Queue.offerUnsafe(queue, snapshot);
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      ),
    };
  }),
);
