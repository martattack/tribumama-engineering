// Files new Sentry errors as GitHub issues, once each, so a person can label
// the ones worth fixing `agent:accepted` and claude-implement.yml takes over.
// Run daily by .github/workflows/sentry-triage.yml. Deterministic on purpose:
// no model runs here, so a quiet day costs nothing.
//
// Dedupe lives in GitHub, not in a state file: every issue carries a hidden
// marker with the Sentry issue id, so reruns, overlapping windows and a missed
// day are all harmless. A Sentry regression on a closed issue reopens it.
//
// Env: SENTRY_AUTH_TOKEN (org:read, event:read), GITHUB_TOKEN, GITHUB_REPOSITORY.
// Optional: SENTRY_ORG, SENTRY_REGION_URL, LOOKBACK, MIN_EVENTS, MAX_NEW_ISSUES,
// DRY_RUN=1 (prints what it would do and writes nothing).
import { fileURLToPath } from "node:url";

// Every filed issue carries this label plus one for where the error came from.
export const SOURCE_LABEL = "source:sentry";
const PROJECT_LABELS = {
  "react-native": "sentry:mobile",
  "supabase-edge-functions": "sentry:edge-function",
};
const ORIGINS = {
  "react-native": "la app móvil",
  "supabase-edge-functions": "una edge function de Supabase",
};
const OTHER_LABEL = "sentry:other";
export const LABELS = {
  [SOURCE_LABEL]: { color: "362d59", description: "Filed automatically from Sentry" },
  "sentry:mobile": { color: "ef574c", description: "Error from the Expo app (Sentry react-native)" },
  "sentry:edge-function": { color: "3ecf8e", description: "Error from a Supabase edge function (via Sentry)" },
  [OTHER_LABEL]: { color: "bfbfbf", description: "Error from another Sentry project" },
};

const MARKER = /<!-- sentry-issue-id: (\d+) -->/;
const BREADCRUMB_LIMIT = 15;
const FRAME_LIMIT = 25;

export function labelsFor(projectSlug) {
  return [SOURCE_LABEL, PROJECT_LABELS[projectSlug] ?? OTHER_LABEL];
}

export function sentryIdFromBody(body) {
  return body?.match(MARKER)?.[1] ?? null;
}

// Warnings and info are noise for an auto-filed queue; errors and crashes are
// not, and at this traffic a single crash is worth a look.
export function shouldFile(issue, minEvents) {
  return ["error", "fatal"].includes(issue.level) && Number(issue.count) >= minEvents;
}

// Issue text ends up in a fenced block that the implementing agent reads as
// data. A stray fence in an error message would end the block early.
function fenceSafe(text) {
  return String(text ?? "").replaceAll("```", "'''");
}

// Outside code fences GitHub renders Markdown and HTML, where an HTML comment
// or a link definition shows nothing. Error text can carry user input, so it
// goes in inline code, on one line and with no backtick to break out: the
// person deciding whether to label `agent:accepted` must see everything the
// implementing agent reads.
function visible(text) {
  const flat = scrub(text).replaceAll("`", "'").replace(/\s*[\r\n]+\s*/g, " ").trim();
  return `\`${flat || "?"}\``;
}

// Error messages and logs can quote whatever the code had in hand. Ids, emails,
// phone numbers and credentials add nothing to a fix and should not land in
// GitHub.
export function scrub(text) {
  return String(text ?? "")
    // Any scheme, any case, and protocol-relative //host links.
    .replace(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s"'<>)]+/gi, redactUrl)
    // A link written without a scheme keeps only its host, like redactUrl.
    .replace(/(?<![\w/.@:-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?\/[^\s"'<>)]*/gi, "$1")
    .replace(/\b(bearer)\s+[^\s"']+/gi, "$1 [redacted]")
    // Basic and Digest credentials are base64-ish, so they carry a digit or
    // padding; that keeps ordinary words after "basic" readable.
    .replace(/\b(basic|digest)\s+(?=[\w+/=.-]*[\d=+/])[\w+/=.-]{8,}/gi, "$1 [redacted]")
    // key=value, key: value and JSON or JS objects with quoted keys or values.
    .replace(
      /(["']?)\b(token|access_token|refresh_token|api[_-]?key|apikey|key|secret|password|signature)\1(\s*[=:]\s*)(?:(["'])[^"']*\4|[^\s"'&,;]+)/gi,
      (_, q, key, sep, quote = "") => `${q}${key}${q}${sep}${quote}[redacted]${quote}`,
    )
    .replace(/eyJ[\w-]*\.[\w-]+\.[\w-]+/g, "[jwt]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[uuid]")
    // 32+ characters mixing letters and digits: keys and signatures, not names.
    .replace(/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{32,}(?![\w-])/g, "[token]")
    // A letter TLD keeps release names like app.tribumama.mobile@1.3.1 intact.
    .replace(/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]")
    // 9+ digits, optionally spaced or dashed: phones, not dates or versions.
    .replace(/(?<![\w-])\+?\d(?:[ -]?\d){8,}(?![\w-])/g, "[phone]");
}

// A third-party path can be a secret on its own (a WhatsApp group invite is
// chat.whatsapp.com/<code>), so other hosts keep only their origin. Supabase
// paths keep only the segments that name the endpoint that failed
// (/rest/v1/<table>, /rest/v1/rpc/<fn>, /functions/v1/<name>); the rest can be
// a signed storage path. Query strings never survive.
export function redactUrl(url) {
  try {
    const parsed = new URL(url.startsWith("//") ? `https:${url}` : url);
    // Other schemes have an opaque origin ("null"), so keep scheme and host.
    if (!["http:", "https:"].includes(parsed.protocol)) return `${parsed.protocol}//${parsed.hostname}`;
    if (!parsed.hostname.endsWith(".supabase.co")) return parsed.origin;
    const parts = parsed.pathname.split("/");
    return `${parsed.origin}${parts.slice(0, parts[3] === "rpc" ? 5 : 4).join("/")}`;
  } catch {
    return "[url]";
  }
}

function formatFrames(event) {
  const exception = event?.entries?.find((entry) => entry.type === "exception");
  const values = exception?.data?.values ?? [];
  const lines = [];
  for (const value of values) {
    lines.push(scrub(`${value.type}: ${value.value ?? ""}`));
    const frames = (value.stacktrace?.frames ?? []).slice(-FRAME_LIMIT).reverse();
    for (const frame of frames) {
      // Device paths carry a per-install container id; the file name is enough.
      const where = (frame.filename ?? frame.module ?? frame.package ?? "?").split("/").pop();
      const line = frame.lineNo ? `:${frame.lineNo}` : "";
      lines.push(scrub(`  ${frame.inApp ? "*" : " "} at ${frame.function ?? "<anonymous>"} (${where}${line})`));
    }
  }
  return lines.length ? lines.join("\n") : "Sin stack trace en el último evento.";
}

function formatBreadcrumbs(event) {
  const entry = event?.entries?.find((item) => item.type === "breadcrumbs");
  const crumbs = (entry?.data?.values ?? []).slice(-BREADCRUMB_LIMIT);
  if (!crumbs.length) return "Sin breadcrumbs.";
  return crumbs
    .map((crumb) => {
      const data = crumb.data ?? {};
      let detail = crumb.message ?? "";
      if (data.url) detail = `${data.method ?? ""} ${data.url} ${data.status_code ?? ""}`.trim();
      else if (data.state) detail = `state=${data.state}`;
      else if (data.action) detail = data.action;
      return `${crumb.timestamp ?? ""} ${crumb.level ?? ""} [${crumb.category ?? crumb.type ?? "?"}] ${scrub(detail)}`.trim();
    })
    .join("\n");
}

const KEPT_TAGS = ["release", "environment", "os", "device", "function", "region", "handled", "mechanism"];

function formatTags(event) {
  const tags = (event?.tags ?? []).filter((tag) => KEPT_TAGS.includes(tag.key));
  return tags.length ? tags.map((tag) => `- \`${tag.key}\`: ${visible(tag.value)}`).join("\n") : "- (sin tags)";
}

export function buildTitle(issue) {
  const title = `[Sentry] ${issue.shortId}: ${scrub(issue.title)}`;
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}

export function buildBody(issue, event) {
  const origin = ORIGINS[issue.project.slug] ?? `el proyecto de Sentry \`${issue.project.slug}\``;
  return `<!-- sentry-issue-id: ${issue.id} -->
Error detectado automáticamente en Sentry, en ${origin}. Revisa los datos y, si merece arreglo, añade la etiqueta \`agent:accepted\` para que se implemente.

## Resumen

- **Sentry:** [${issue.shortId}](${issue.permalink})
- **Error:** ${visible(issue.title)}
- **Culprit:** ${visible(issue.culprit || "?")}
- **Nivel:** ${issue.level}${issue.isUnhandled ? " (no manejado)" : ""}
- **Eventos:** ${issue.count} · **Usuarias afectadas:** ${issue.userCount}
- **Primera vez:** ${issue.firstSeen} · **Última vez:** ${issue.lastSeen}
- **Estado en Sentry:** ${issue.substatus ?? issue.status}

### Tags del último evento

${formatTags(event)}

### Stack trace del último evento (\`*\` = código propio)

\`\`\`
${fenceSafe(formatFrames(event))}
\`\`\`

### Últimos breadcrumbs (sin query strings)

\`\`\`
${fenceSafe(formatBreadcrumbs(event))}
\`\`\`

## Propuesta

Encontrar la causa raíz de este error a partir del stack trace, los breadcrumbs y el código, y corregirla. Si el stack no contiene código propio y no se puede atribuir con certeza, no adivinar: detener la implementación y explicar qué haría falta para reproducirlo.

## Criterios de aceptación

- La causa raíz está identificada y explicada en el PR, con la línea de código responsable.
- Un test reproduce el fallo antes del fix y pasa después, cuando el error es reproducible en tests.
- El PR incluye \`Fixes ${issue.shortId}\` en la descripción. Sentry lo resuelve automáticamente solo si recibe datos de commits y releases; si no, se resuelve a mano en Sentry tras publicar el fix.
`;
}

const GITHUB_API = "https://api.github.com";

// The next page's URL from a Link header, which GitHub asks clients to follow
// instead of building page numbers themselves.
export function nextPageUrl(link) {
  return link?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
}

class Api {
  constructor({ sentryToken, sentryBase, org, githubToken, repo, dryRun, writePauseMs }) {
    Object.assign(this, { sentryToken, sentryBase, org, githubToken, repo, dryRun, writePauseMs });
  }

  async sentry(path) {
    const response = await fetch(`${this.sentryBase}/api/0/${path}`, {
      headers: { Authorization: `Bearer ${this.sentryToken}` },
    });
    if (!response.ok) throw new Error(`Sentry ${path} returned ${response.status}: ${await response.text()}`);
    return response.json();
  }

  async githubRaw(url, { method = "GET", body } = {}) {
    // GitHub asks for at least a second between writes to stay clear of its
    // secondary rate limits.
    if (method !== "GET" && this.writePauseMs) await new Promise((r) => setTimeout(r, this.writePauseMs));
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async github(path, { method = "GET", body } = {}) {
    if (this.dryRun && method !== "GET") {
      console.log(`[dry run] ${method} ${path}`, body ? JSON.stringify(body).slice(0, 200) : "");
      return {};
    }
    const response = await this.githubRaw(`${GITHUB_API}/repos/${this.repo}/${path}`, { method, body });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${path} returned ${response.status}: ${await response.text()}`);
    return response.status === 204 ? {} : response.json();
  }

  async ensureLabels() {
    for (const [name, spec] of Object.entries(LABELS)) {
      const existing = await this.github(`labels/${encodeURIComponent(name)}`);
      if (!existing) await this.github("labels", { method: "POST", body: { name, ...spec } });
    }
  }

  // Every issue this script ever filed, open or closed, keyed by Sentry id.
  async filedIssues() {
    const byId = new Map();
    let url = `${GITHUB_API}/repos/${this.repo}/issues?labels=${encodeURIComponent(SOURCE_LABEL)}&state=all&per_page=100`;
    while (url) {
      const response = await this.githubRaw(url);
      if (!response.ok) throw new Error(`GitHub GET ${url} returned ${response.status}: ${await response.text()}`);
      for (const issue of await response.json()) {
        const id = sentryIdFromBody(issue.body);
        if (id && !issue.pull_request) byId.set(id, issue);
      }
      url = nextPageUrl(response.headers.get("link"));
    }
    return byId;
  }
}

export async function run(env = process.env, { writePauseMs = 1000 } = {}) {
  const dryRun = env.DRY_RUN === "1" || env.DRY_RUN === "true";
  for (const key of ["SENTRY_AUTH_TOKEN", "GITHUB_TOKEN", "GITHUB_REPOSITORY"]) {
    if (!env[key]) throw new Error(`Missing ${key}`);
  }
  const api = new Api({
    sentryToken: env.SENTRY_AUTH_TOKEN,
    sentryBase: env.SENTRY_REGION_URL || "https://de.sentry.io",
    org: env.SENTRY_ORG || "tribumama",
    githubToken: env.GITHUB_TOKEN,
    repo: env.GITHUB_REPOSITORY,
    dryRun,
    writePauseMs,
  });
  const lookback = env.LOOKBACK || "2d";
  const minEvents = Number(env.MIN_EVENTS || 1);
  const maxNew = Number(env.MAX_NEW_ISSUES || 5);

  // Test phones report under their own environment (sentryEnvironment.ts);
  // only errors real users hit become issues.
  const query = encodeURIComponent(`is:unresolved environment:production lastSeen:-${lookback}`);
  const candidates = (
    await api.sentry(`organizations/${api.org}/issues/?query=${query}&statsPeriod=14d&sort=freq&limit=100`)
  ).filter((issue) => shouldFile(issue, minEvents));
  console.log(`${candidates.length} unresolved Sentry issue(s) seen in the last ${lookback}`);
  if (!candidates.length) return;

  await api.ensureLabels();
  const filed = await api.filedIssues();
  let created = 0;

  for (const issue of candidates) {
    const existing = filed.get(issue.id);
    if (existing) {
      // Closed as fixed here but back in Sentry after the close: the fix did
      // not hold. Closed as "not planned" stays closed, so a dismissed error
      // is not refiled every day.
      const backAfterClose =
        existing.state === "closed" &&
        existing.state_reason !== "not_planned" &&
        new Date(issue.lastSeen) > new Date(existing.closed_at);
      if (backAfterClose) {
        console.log(`Reopening #${existing.number} for ${issue.shortId}`);
        await api.github(`issues/${existing.number}`, { method: "PATCH", body: { state: "open" } });
        await api.github(`issues/${existing.number}/comments`, {
          method: "POST",
          body: {
            body: `${issue.shortId} ha vuelto a ocurrir después de cerrar este issue (última vez: ${issue.lastSeen}, ${issue.count} eventos en total). Reabierto automáticamente.`,
          },
        });
      }
      continue;
    }
    if (created >= maxNew) {
      console.log(`Reached MAX_NEW_ISSUES=${maxNew}; ${issue.shortId} waits for the next run`);
      continue;
    }
    const event = await api.sentry(`organizations/${api.org}/issues/${issue.id}/events/latest/`);
    console.log(`Filing ${issue.shortId} (${issue.project.slug})`);
    const result = await api.github("issues", {
      method: "POST",
      body: { title: buildTitle(issue), body: buildBody(issue, event), labels: labelsFor(issue.project.slug) },
    });
    if (result.number) console.log(`  -> #${result.number}`);
    // GitHub drops labels silently when the token lacks push access, and every
    // later run finds already-filed errors by the source label. Stop here
    // rather than file the same error again tomorrow.
    if (!dryRun && !result.labels?.some((label) => label.name === SOURCE_LABEL)) {
      throw new Error(
        `#${result.number} was created without the ${SOURCE_LABEL} label, so the next run would file it again. Check the workflow token can set labels (permissions: issues: write).`,
      );
    }
    created += 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
