import { expect, it } from "vitest";
import { runCliProcessChild } from "../../../../src/cli/cli-process-child.test-helpers.js";
import { startCodexAuthCatalogFixture } from "./codex-auth-catalog.test-support.js";

function token(accountId: string) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
}

it.for(["child", "worker"])(
  "isolates catalog HTTP and rejects wrong auth in the %s",
  async (mode, context) => {
    const accountA = "qa-codex-configured-account";
    const accountB = "qa-codex-account";
    const accessA = token(accountA);
    const accessB = token(accountB);
    const wrongClaim = token("qa-codex-wrong-account");
    const fixture = await startCodexAuthCatalogFixture(context, [
      { accountId: accountA, accessToken: accessA },
      { accountId: accountB, accessToken: accessB },
      { accountId: accountA, accessToken: wrongClaim },
      { accountId: accountB, accessToken: "test-oauth-access" },
    ]);
    const endpoint = "https://chatgpt.com/backend-api/codex/models?client_version=0.154.0";
    const cases = [
      { headers: { authorization: `Bearer ${accessA}` }, status: 200 },
      {
        headers: { authorization: `Bearer ${accessB}`, "ChatGPT-Account-ID": accountB },
        status: 200,
      },
      {
        headers: { authorization: "Bearer test-oauth-access", "ChatGPT-Account-ID": accountB },
        status: 200,
      },
      { headers: {}, status: 401 },
      { headers: { authorization: "Bearer unknown" }, status: 401 },
      { headers: { authorization: `Bearer ${accessA}.changed` }, status: 401 },
      { headers: { authorization: `Bearer ${wrongClaim}` }, status: 403 },
      {
        headers: { authorization: `Bearer ${accessA}`, "ChatGPT-Account-ID": accountB },
        status: 403,
      },
      { headers: { authorization: "Bearer test-oauth-access" }, status: 403 },
    ];
    const requests = `
    import assert from 'node:assert/strict';
    const endpoint = ${JSON.stringify(endpoint)};
    const results = [];
    for (const { headers, status } of ${JSON.stringify(cases)}) {
      const response = await fetch(endpoint, { headers });
      assert.equal(response.status, status);
      const body = await response.json();
      if (status === 200) assert.equal(body.models[0].slug, 'gpt-5.6-luna');
      else assert.equal(body.error, 'Fixture catalog credentials rejected');
      results.push(status);
    }
    for (const [url, method] of [
      [endpoint, 'POST'],
      [endpoint + '&unexpected=1', 'GET'],
      ['https://catalog.invalid/models', 'GET'],
    ]) {
      await assert.rejects(fetch(url, { method, headers: { authorization: ${JSON.stringify(`Bearer ${accessA}`)} } }),
        { message: 'Unexpected Codex auth fixture catalog request' });
    }
    assert.equal(await (await fetch('data:text/plain,unrelated')).text(), 'unrelated');
  `;
    const source =
      mode === "child"
        ? `${requests}\nconsole.log(JSON.stringify(results));`
        : `
      import { once } from 'node:events';
      import { Worker } from 'node:worker_threads';
      const worker = new Worker(new URL(${JSON.stringify(`data:text/javascript,${encodeURIComponent(`${requests}\nimport { parentPort } from 'node:worker_threads'; parentPort.postMessage(results);`)}`)}), { execArgv: [] });
      const [message, exit] = await Promise.all([once(worker, 'message'), once(worker, 'exit')]);
      if (exit[0] !== 0) throw new Error('Catalog fixture worker failed');
      console.log(JSON.stringify(message[0]));
    `;
    const result = await runCliProcessChild({
      nodeArgs: ["--import", fixture.preload.href, "--input-type=module", "--eval", source],
      env: process.env,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(JSON.parse(result.stdout)).toEqual(cases.map(({ status }) => status));
    expect(fixture.receipts.map(({ status }) => status)).toEqual(cases.map(({ status }) => status));
    expect(result.stderr.match(/"status":"refused"/gu)).toHaveLength(3);
    expect(JSON.stringify(fixture.receipts)).not.toContain(accessA);
    expect(result.stderr).not.toContain(accessA);
  },
);
