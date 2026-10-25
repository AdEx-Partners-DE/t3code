import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthSessionId,
  EnvironmentHttpApi,
  ServerDrainError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as AuthHttp from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DeploymentDrain from "./DeploymentDrain.ts";
import * as DeploymentDrainHttp from "./deploymentDrainHttp.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.maintenance) {}
const leaseId = "bb379c6e-bede-41f2-8dd3-7977b0a41385";

it.effect(
  "requires authentication and maintain scope, validates input, and encodes lease/error results",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const routes = HttpApiBuilder.layer(TestApi).pipe(
        Layer.provide(DeploymentDrainHttp.layer),
        Layer.provide(
          Layer.succeed(DeploymentDrain.DeploymentDrain, {
            execute: (input) =>
              Effect.suspend(() => {
                calls += 1;
                return input.operation === "cancel"
                  ? Effect.fail(new ServerDrainError({ reason: "lease_conflict" }))
                  : Effect.succeed({
                      state: "held" as const,
                      pid: process.pid,
                      leaseId,
                      expiresAt: 120_000,
                      disposition: "s97-recovery" as const,
                    });
              }),
          }),
        ),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateHttpRequest: (request) =>
              request.headers.authorization === undefined
                ? Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))
                : Effect.succeed({
                    sessionId: AuthSessionId.make("drain-http"),
                    subject: "test",
                    method: "bearer-access-token" as const,
                    scopes:
                      request.headers.authorization === "Bearer maintainer"
                        ? [AuthEnvironmentMaintainScope]
                        : [],
                  }),
          }),
        ),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        ({ handler }) =>
          Effect.promise(async () => {
            const post = (body: unknown, authorization?: string) =>
              handler(
                new Request("http://localhost/api/maintenance/drain", {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    ...(authorization ? { authorization } : {}),
                  },
                  body: JSON.stringify(body),
                }),
              );
            assert.equal((await post({ operation: "status" })).status, 401);
            assert.equal((await post({ operation: "status" }, "Bearer operator")).status, 403);
            assert.equal(
              (await post({ operation: "acquire", leaseId: "invalid" }, "Bearer maintainer"))
                .status,
              400,
            );
            assert.equal(calls, 0);
            const held = await post(
              { operation: "acquire", leaseId, recoveryPolicy: "s97" },
              "Bearer maintainer",
            );
            assert.equal(held.status, 200);
            assert.deepEqual(await held.json(), {
              state: "held",
              pid: process.pid,
              leaseId,
              expiresAt: 120_000,
              disposition: "s97-recovery",
            });
            const conflict = await post({ operation: "cancel", leaseId }, "Bearer maintainer");
            assert.equal(conflict.status, 409);
            assert.deepEqual(await conflict.json(), {
              _tag: "ServerDrainError",
              reason: "lease_conflict",
            });
          }),
        ({ dispose }) => Effect.promise(dispose),
      );
    }),
);
