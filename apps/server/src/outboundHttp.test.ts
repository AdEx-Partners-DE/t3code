// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect } from "vite-plus/test";

import { builtinFetchUsesHttp2, installHttp1FetchDispatcher } from "./outboundHttp.ts";

// Self-signed P-256 certificate for 127.0.0.1, valid until 2126. Test-only:
// it lets a local server offer h2 over ALPN, which only happens over TLS.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

// An h2-capable origin, like api.github.com, that answers with the HTTP
// version the client negotiated.
const server = NodeHttp2.createSecureServer(
  { allowHTTP1: true, key: TEST_KEY, cert: TEST_CERT },
  (request, response) => response.end(request.httpVersion),
);
let origin = "";
const defaultCaCertificates = NodeTls.getCACertificates("default");
const defaultDispatcher = Undici.getGlobalDispatcher();

beforeAll(async () => {
  NodeTls.setDefaultCACertificates([...defaultCaCertificates, TEST_CERT]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`;
});

afterEach(() => {
  Undici.setGlobalDispatcher(defaultDispatcher);
});

afterAll(async () => {
  NodeTls.setDefaultCACertificates(defaultCaCertificates);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const versionViaGlobalDispatcher = async () => (await Undici.request(origin)).body.text();

const versionViaEffectFetch = () =>
  HttpClient.get(origin).pipe(
    Effect.flatMap((response) => response.text),
    Effect.provide(FetchHttpClient.layer),
  );

describe("installHttp1FetchDispatcher", () => {
  it("makes the global dispatcher negotiate HTTP/1.1 with an h2-capable origin", async () => {
    // undici 8's default agent, the one Node 26's fetch uses.
    Undici.setGlobalDispatcher(new Undici.Agent());
    expect(await versionViaGlobalDispatcher()).toBe("2.0");

    installHttp1FetchDispatcher();

    expect(await versionViaGlobalDispatcher()).toBe("1.1");
  });

  it("keeps the environment proxy agent Node installs for --use-env-proxy", async () => {
    Undici.setGlobalDispatcher(new Undici.EnvHttpProxyAgent());

    installHttp1FetchDispatcher();

    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
    expect(await versionViaGlobalDispatcher()).toBe("1.1");
  });

  // Only a runtime that bundles undici 8 (Node 26+) offers h2 through the
  // built-in fetch, so only there can the server's own request path show it.
  it.effect.runIf(builtinFetchUsesHttp2(process.versions.undici))(
    "moves the built-in fetch behind Effect's FetchHttpClient off HTTP/2",
    () =>
      Effect.gen(function* () {
        expect(yield* versionViaEffectFetch()).toBe("2.0");

        installHttp1FetchDispatcher();

        expect(yield* versionViaEffectFetch()).toBe("1.1");
      }),
  );
});
