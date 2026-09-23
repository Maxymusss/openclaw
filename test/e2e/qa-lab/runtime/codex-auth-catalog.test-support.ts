import { createServer } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, type TestContext } from "vitest";

type CatalogAccount = { accessToken: string; accountId: string };
type CatalogReceipt = { endpoint: string; accountId: string | null; status: number };

export async function startCodexAuthCatalogFixture(
  context: TestContext,
  accounts: readonly CatalogAccount[],
) {
  const receipts: CatalogReceipt[] = [];
  let overflow = false;
  const server = createServer((request, response) => {
    const endpoint = "/backend-api/codex/models?client_version=0.154.0";
    const authorization = request.headers.authorization;
    const account = accounts.find(({ accessToken }) => authorization === `Bearer ${accessToken}`);
    let status = request.url === endpoint && request.method === "GET" ? 200 : 400;
    if (status === 200 && !account) {
      status = 401;
    }
    if (status === 200 && account) {
      let decodedAccount: unknown;
      try {
        const claims: unknown = JSON.parse(
          Buffer.from(account.accessToken.split(".")[1] ?? "", "base64url").toString(),
        );
        decodedAccount =
          isRecord(claims) && isRecord(claims["https://api.openai.com/auth"])
            ? claims["https://api.openai.com/auth"].chatgpt_account_id
            : undefined;
      } catch {
        // The migration case deliberately uses an opaque OAuth fixture token;
        // its separately persisted account metadata must reach the HTTP header.
        if (account.accessToken === "test-oauth-access") {
          decodedAccount = request.headers["chatgpt-account-id"];
        }
      }
      const headerAccount = request.headers["chatgpt-account-id"];
      if (
        decodedAccount !== account.accountId ||
        (headerAccount !== undefined && headerAccount !== decodedAccount)
      ) {
        status = 403;
      }
    }
    if (receipts.length >= 64) {
      overflow = true;
      response.writeHead(429).end();
      return;
    }
    const receipt = {
      endpoint: request.url === endpoint ? "codex/models" : "unexpected",
      accountId: account?.accountId ?? null,
      status,
    };
    receipts.push(receipt);
    console.log(`[qa-codex-catalog-http] ${JSON.stringify(receipt)}`);
    response.setHeader("content-type", "application/json");
    response.writeHead(status).end(
      JSON.stringify(
        status === 200
          ? {
              models: [
                {
                  slug: "gpt-5.6-luna",
                  display_name: "GPT-5.6 Luna",
                  visibility: "list",
                  show_in_picker: true,
                  context_window: 128_000,
                  max_output_tokens: 4096,
                },
              ],
            }
          : { error: "Fixture catalog credentials rejected" },
      ),
    );
  });
  context.onTestFinished(async () => {
    if (!server.listening) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Codex auth catalog fixture did not bind loopback");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const preload = new URL("./codex-auth-catalog-preload.fixture.mjs", import.meta.url);
  preload.searchParams.set("fixture", baseUrl);
  const assertValidTraffic = (gatewayLogs: string) => {
    expect(gatewayLogs).not.toContain("[qa-codex-catalog-transport]");
    expect(overflow, "catalog fixture receipt limit reached").toBe(false);
    expect(
      receipts.every(({ status }) => status === 200),
      "catalog fixture rejected a request",
    ).toBe(true);
  };
  return {
    baseUrl,
    preload,
    gatewayCommandPrefix: [process.execPath, "--import", preload.href],
    receipts,
    assertValidTraffic,
    assertObservedAccount(accountId: string, gatewayLogs: string) {
      assertValidTraffic(gatewayLogs);
      expect(receipts).toEqual(
        expect.arrayContaining([{ endpoint: "codex/models", accountId, status: 200 }]),
      );
    },
  };
}
