// node --test scripts/sentry-triage.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBody, buildTitle, labelsFor, nextPageUrl, redactUrl, run as runTriage, scrub, sentryIdFromBody, shouldFile } from "./sentry-triage.mjs";

// No pause between writes in tests.
const run = (env) => runTriage(env, { writePauseMs: 0 });

const issue = {
  id: "100000001",
  shortId: "REACT-NATIVE-8",
  title: "EXC_BAD_ACCESS: scrollTo >",
  culprit: "facebook::react::RuntimeScheduler_Modern::updateRendering",
  level: "fatal",
  isUnhandled: true,
  count: "3",
  userCount: 3,
  firstSeen: "2026-10-11T12:37:19Z",
  lastSeen: "2026-10-12T15:56:05Z",
  status: "unresolved",
  substatus: "new",
  permalink: "https://example.sentry.io/issues/100000001/",
  project: { slug: "react-native" },
};

const event = {
  tags: [
    { key: "release", value: "app.tribumama.mobile@1.3.1+21" },
    { key: "user", value: "id:SECRET-USER" },
  ],
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "EXC_BAD_ACCESS",
            value: "scrollTo ```oops",
            stacktrace: { frames: [{ function: "runEventLoop", inApp: false }, { function: "send", filename: "app/chat.tsx", lineNo: 12, inApp: true }] },
          },
        ],
      },
    },
    {
      type: "breadcrumbs",
      data: {
        values: [
          { category: "xhr", level: "info", data: { method: "GET", url: "https://x.supabase.co/rest/v1/tribe_members?user_id=eq.SECRET", status_code: 200 } },
          { category: "app.lifecycle", level: "info", data: { state: "foreground" } },
        ],
      },
    },
  ],
};

test("labels by Sentry project", () => {
  assert.deepEqual(labelsFor("react-native"), ["source:sentry", "sentry:mobile"]);
  assert.deepEqual(labelsFor("supabase-edge-functions"), ["source:sentry", "sentry:edge-function"]);
  assert.deepEqual(labelsFor("cloudflare-workers"), ["source:sentry", "sentry:other"]);
});

test("files errors and crashes over the threshold, never warnings", () => {
  assert.equal(shouldFile(issue, 1), true);
  assert.equal(shouldFile({ ...issue, level: "warning" }, 1), false);
  assert.equal(shouldFile(issue, 5), false);
});

test("body carries the dedupe marker, context and the sections implement-issue reads", () => {
  const body = buildBody(issue, event);
  assert.equal(sentryIdFromBody(body), "100000001");
  assert.match(body, /## Propuesta/);
  assert.match(body, /## Criterios de aceptación/);
  assert.match(body, /Fixes REACT-NATIVE-8/);
  assert.match(body, /\* at send \(chat.tsx:12\)/);
  assert.match(body, /state=foreground/);
});

test("body leaks no user ids or query strings, and no fence can break out", () => {
  const body = buildBody(issue, event);
  assert.doesNotMatch(body, /SECRET/);
  assert.equal(body.split("```").length - 1, 4);
});

test("scrubs ids, emails and phones but keeps releases, dates and versions", () => {
  assert.equal(
    scrub("user 532b6860-e669-4519-b5d8-6b43e47d84b3 ana@example.com +34 612 345 678"),
    "user [uuid] [email] [phone]",
  );
  const kept = "app.tribumama.mobile@1.3.1+21 at 2026-10-12T15:56:05Z line 1234";
  assert.equal(scrub(kept), kept);
});

test("Sentry text outside fences stays in inline code, so the person labelling sees what the agent reads", () => {
  // HTML comments and Markdown link definitions render as nothing.
  const sneaky = "a <!-- sentry-issue-id: 1 --> `b`\n[x]: https://evil.example/\r\nc";
  const body = buildBody(
    { ...issue, title: sneaky, culprit: sneaky },
    { ...event, tags: [{ key: "release", value: sneaky }] },
  );
  const line = "`a <!-- sentry-issue-id: 1 --> 'b' [x]: https://evil.example c`";
  assert.match(body, new RegExp(`\\*\\*Error:\\*\\* ${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(body.includes(`\`release\`: ${line}`));
  assert.doesNotMatch(body, /^\[x\]:/m);
  assert.equal(sentryIdFromBody(body), issue.id);
});

test("scrubs tokens that are not inside a full URL", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const text = [
    `Authorization: Bearer ${jwt}`,
    `token=${jwt}`,
    "apikey: sb_secret_Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56",
    "invite chat.whatsapp.com/AbCdEf1234567890GhIjKl",
    "blob 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928",
  ].join("\n");
  const out = scrub(text);
  assert.doesNotMatch(out, /eyJ|sb_secret|AbCdEf1234567890|9f8e7d6c5b4a/);
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /token=\[redacted\]/);
});

test("keeps only the endpoint of a Supabase path", () => {
  assert.equal(redactUrl("https://x.supabase.co/rest/v1/tribe_members?user_id=eq.1"), "https://x.supabase.co/rest/v1/tribe_members");
  assert.equal(redactUrl("https://x.supabase.co/storage/v1/object/sign/avatars/abc/photo.jpg"), "https://x.supabase.co/storage/v1/object");
});

test("titles stay short", () => {
  assert.ok(buildTitle({ ...issue, title: "x".repeat(300) }).length <= 120);
});

// Mirrors the real API: created issues echo their labels unless the token
// cannot set them, and listings page through Link headers.
function fakeApis({ sentryIssues, githubIssues, githubPages, dropLabels = false }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
    if (String(url).includes("/events/latest/")) return json(event);
    if (String(url).includes("sentry.io")) return json(sentryIssues);
    if (String(url).includes("/labels/")) return json({ name: "exists" });
    if (String(url).includes("/issues?labels=")) {
      if (!githubPages) return json(githubIssues);
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const headers = page < githubPages.length
        ? { link: `<https://api.github.com/repos/o/r/issues?labels=x&page=${page + 1}>; rel="next"` }
        : {};
      return new Response(JSON.stringify(githubPages[page - 1]), { status: 200, headers });
    }
    if (method === "POST" && String(url).endsWith("/issues")) {
      const labels = dropLabels ? [] : JSON.parse(init.body).labels.map((name) => ({ name }));
      return json({ number: 42, labels }, 201);
    }
    return json({});
  };
  return calls;
}

const env = { SENTRY_AUTH_TOKEN: "t", GITHUB_TOKEN: "g", GITHUB_REPOSITORY: "o/r" };
const created = (calls) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues"));

test("files a new Sentry issue once, labelled by source", async () => {
  const calls = fakeApis({ sentryIssues: [issue], githubIssues: [] });
  await run(env);
  assert.equal(created(calls).length, 1);
  assert.deepEqual(created(calls)[0].body.labels, ["source:sentry", "sentry:mobile"]);
});

test("only asks Sentry for production errors, so test builds never become issues", async () => {
  const calls = fakeApis({ sentryIssues: [], githubIssues: [] });
  await run(env);
  const query = new URL(calls.find((c) => c.url.includes("/issues/?")).url).searchParams.get("query");
  assert.match(query, /\benvironment:production\b/);
});

test("skips an issue that is already filed and open", async () => {
  const calls = fakeApis({
    sentryIssues: [issue],
    githubIssues: [{ number: 7, state: "open", body: buildBody(issue, event) }],
  });
  await run(env);
  assert.equal(created(calls).length, 0);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("reopens a fixed issue when Sentry sees it again after the close", async () => {
  const calls = fakeApis({
    sentryIssues: [issue],
    githubIssues: [{ number: 7, state: "closed", state_reason: "completed", closed_at: "2026-10-11T00:00:00Z", body: buildBody(issue, event) }],
  });
  await run(env);
  assert.equal(created(calls).length, 0);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body, { state: "open" });
});

test("leaves an issue closed as not planned alone", async () => {
  const calls = fakeApis({
    sentryIssues: [issue],
    githubIssues: [{ number: 7, state: "closed", state_reason: "not_planned", closed_at: "2026-10-11T00:00:00Z", body: buildBody(issue, event) }],
  });
  await run(env);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
});

test("caps how many issues one run opens", async () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...issue, id: String(i), shortId: `RN-${i}` }));
  const calls = fakeApis({ sentryIssues: many, githubIssues: [] });
  await run({ ...env, MAX_NEW_ISSUES: "5" });
  assert.equal(created(calls).length, 5);
});

test("dry run writes nothing", async () => {
  const calls = fakeApis({ sentryIssues: [issue], githubIssues: [] });
  await run({ ...env, DRY_RUN: "1" });
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0);
});

test("follows Link headers through every page of filed issues", async () => {
  assert.equal(nextPageUrl('<https://x/2>; rel="next", <https://x/9>; rel="last"'), "https://x/2");
  assert.equal(nextPageUrl('<https://x/1>; rel="prev"'), null);
  const filedOnPage2 = { number: 7, state: "open", body: buildBody(issue, event) };
  const calls = fakeApis({ sentryIssues: [issue], githubPages: [[], [filedOnPage2]] });
  await run(env);
  assert.equal(created(calls).length, 0);
});

test("stops loudly when GitHub drops the labels dedupe depends on", async () => {
  const calls = fakeApis({ sentryIssues: [issue, { ...issue, id: "2", shortId: "RN-2" }], githubIssues: [], dropLabels: true });
  await assert.rejects(run(env), /without the source:sentry label/);
  assert.equal(created(calls).length, 1);
});

// Regression: a breadcrumb carried a real tribe's WhatsApp invite link into
// issue #246. Anyone holding it could join the group.
test("third-party URLs keep only their host, so invite codes never reach an issue", () => {
  assert.equal(redactUrl("https://chat.whatsapp.com/AbCdEf123?mode=gi_t"), "https://chat.whatsapp.com");
  assert.equal(redactUrl("https://pps.whatsapp.net/v/t61/123_n.jpg?oh=x"), "https://pps.whatsapp.net");
  assert.equal(
    redactUrl("https://abc.supabase.co/rest/v1/rpc/get_chat_overview?x=1"),
    "https://abc.supabase.co/rest/v1/rpc/get_chat_overview",
  );
  assert.equal(scrub("Failed to open https://chat.whatsapp.com/AbCdEf123 now"), "Failed to open https://chat.whatsapp.com now");

  const leaky = {
    ...event,
    entries: [
      {
        type: "exception",
        data: { values: [{ type: "Error", value: "x", stacktrace: { frames: [{ function: "f", filename: "/private/var/containers/Bundle/Application/0FF8E1C0-919A-44B1-949B-F7A6CAA4ED9E/TribuMama.app/main.jsbundle", inApp: true }] } }] },
      },
      { type: "breadcrumbs", data: { values: [{ category: "xhr", level: "info", data: { method: "GET", url: "https://chat.whatsapp.com/AbCdEf123?mode=gi_t", status_code: 200 } }] } },
    ],
  };
  const body = buildBody(issue, leaky);
  assert.doesNotMatch(body, /AbCdEf123|0FF8E1C0|containers/);
  assert.match(body, /GET https:\/\/chat\.whatsapp\.com 200/);
  assert.match(body, /at f \(main\.jsbundle\)/);
});
