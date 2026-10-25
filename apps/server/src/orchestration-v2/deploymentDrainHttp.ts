import { AuthEnvironmentMaintainScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as DeploymentDrain from "./DeploymentDrain.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "maintenance",
  Effect.fnUntraced(function* (handlers) {
    const drain = yield* DeploymentDrain.DeploymentDrain;
    return handlers.handle("drain", ({ payload }) =>
      requireEnvironmentScope(AuthEnvironmentMaintainScope).pipe(
        Effect.andThen(drain.execute(payload)),
      ),
    );
  }),
);
