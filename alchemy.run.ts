import { AlchemyContext, Stack, Stage, localState } from "alchemy"
import { Array as Arr, Config, Context, Effect, Hash, Layer, Number, Option, Record as Rec, Struct, pipe } from "effect"
import { Worker as CloudflareWorker, DurableObject, RateLimit, providers, state } from "alchemy/Cloudflare"
import { Build } from "alchemy/Command"
import type { HardcoverConnection as HardcoverConnectionClass } from "#src/connection/durable-object.ts"
import type { InferEnv } from "alchemy/Cloudflare"
import { Namespace as KVNamespace } from "alchemy/Cloudflare/KV"
import { PAGES } from "#root/site/routes.ts"

/** Who may connect to a deployment, where it's served, and which Hardcover it talks to. */
interface DeploymentSettings {
  /**
   * Hardcover usernames or numeric user ids allowed to connect. `"*"` lets anyone connect, each with their own account
   * and Hardcover rate limit. Empty locks everyone out.
   */
  readonly allowedUsers: ReadonlyArray<string>
  /** A hostname on a zone in the Cloudflare account, such as `hardcover.example.com`. Without one, it uses the auto-assigned workers.dev URL. */
  readonly domain?: string
  /** Hardcover's OAuth issuer and GraphQL endpoint, if not the real ones; the e2e tests use a mock. */
  readonly hardcover?: HardcoverEndpoints
  /** Let the Worker fetch private network addresses, as the e2e tests' loopback mock needs. */
  readonly allowPrivateFetch?: boolean
}

/** Where the Worker reaches Hardcover. */
interface HardcoverEndpoints {
  readonly graphqlUrl: string
  readonly issuer: string
}

/** The bindings a deployment's settings become. */
interface DeploymentBindings {
  /** Usernames or numeric ids separated by commas; `*` allows everyone. */
  readonly ALLOWED_HARDCOVER_USERS: string
  readonly HARDCOVER_GRAPHQL_URL: string
  readonly HARDCOVER_ISSUER: string
  /** The canonical origin, or empty to use each request's. */
  readonly PUBLIC_URL: string
}

/** The deployment being deployed or run, which each Alchemy entrypoint provides. */
class Deployment extends Context.Service<Deployment, DeploymentSettings>()("hardcover-oauth-mcp/alchemy.run/Deployment") {}

/**
 * Deployments by stage (`--stage`). `prod` is the public instance; for your own, edit it or add a stage. `local` is
 * `mise run dev`. The e2e tests bring their own (test/e2e.run.ts). The Hardcover app's credentials come from `.env`.
 */
const DEPLOYMENTS: Readonly<Record<string, DeploymentSettings>> = {
  local: { allowedUsers: ["*"] },
  prod: { allowedUsers: ["*"], domain: "hardcover.benjuntilla.com" },
}

const HARDCOVER: HardcoverEndpoints = { graphqlUrl: "https://api.hardcover.app/v1/graphql", issuer: "https://api.hardcover.app" }
const WORKER_NAME = "hardcover-oauth-mcp"
const NAMESPACE_BASE = 1000
const NAMESPACE_SPAN = 1_000_000_000
const RATE_PERIOD_SECONDS = 60
const REGISTER_LIMIT = 10
const AUTHORIZE_LIMIT = 30
const TOKEN_LIMIT = 60
const MCP_LIMIT = 120
const PUBLIC_FETCH_FLAG = "global_fetch_strictly_public"
/** The Markdown files the static site is built from. */
const SITE_FILES = pipe(
  PAGES,
  Arr.map((page) => page.file),
)

/** OAuth grants, codes, and client registrations for the MCP-facing authorization server. */
const OAuthKV = KVNamespace("OAuthKV")

/** One instance per MCP connection: holds its rotating Hardcover tokens and serves its MCP sessions. */
const HardcoverConnection = DurableObject<HardcoverConnectionClass>("HardcoverConnection", {
  className: "HardcoverConnection",
})

/**
 * Rate-limit namespace ids must be unique within the account; derive them from the Worker name.
 * @param {string} purpose What the namespace limits.
 * @returns {number} A positive id derived from the Worker name and purpose.
 */
const namespaceId = (purpose: string): number => {
  const hash = pipe(Hash.string(`${WORKER_NAME}:${purpose}`), Number.remainder(NAMESPACE_SPAN))
  return NAMESPACE_BASE + Math.abs(hash)
}

/** The bindings every deployment shares; the Worker adds the deployment's own. */
const sharedEnv = {
  AUTHORIZE_RATE_LIMIT: RateLimit("AUTHORIZE_RATE_LIMIT", {
    namespaceId: namespaceId("AUTHORIZE_RATE_LIMIT"),
    simple: { limit: AUTHORIZE_LIMIT, period: RATE_PERIOD_SECONDS },
  }),
  HARDCOVER_CLIENT_ID: Config.Redacted("HARDCOVER_CLIENT_ID"),
  HARDCOVER_CLIENT_SECRET: Config.Redacted("HARDCOVER_CLIENT_SECRET"),
  HARDCOVER_CONNECTION: HardcoverConnection,
  MCP_RATE_LIMIT: RateLimit("MCP_RATE_LIMIT", {
    namespaceId: namespaceId("MCP_RATE_LIMIT"),
    simple: { limit: MCP_LIMIT, period: RATE_PERIOD_SECONDS },
  }),
  OAUTH_KV: OAuthKV,
  REGISTER_RATE_LIMIT: RateLimit("REGISTER_RATE_LIMIT", {
    namespaceId: namespaceId("REGISTER_RATE_LIMIT"),
    simple: { limit: REGISTER_LIMIT, period: RATE_PERIOD_SECONDS },
  }),
  TOKEN_RATE_LIMIT: RateLimit("TOKEN_RATE_LIMIT", {
    namespaceId: namespaceId("TOKEN_RATE_LIMIT"),
    simple: { limit: TOKEN_LIMIT, period: RATE_PERIOD_SECONDS },
  }),
}

/**
 * The deployment's own bindings: its allowlist, its Hardcover, and its custom domain's URL.
 * @param {DeploymentSettings} deployment The deployment.
 * @returns {DeploymentBindings} The bindings.
 */
const deploymentEnv = (deployment: DeploymentSettings): DeploymentBindings => {
  const hardcover = deployment.hardcover ?? HARDCOVER
  return {
    ALLOWED_HARDCOVER_USERS: Arr.join(deployment.allowedUsers, ","),
    HARDCOVER_GRAPHQL_URL: hardcover.graphqlUrl,
    HARDCOVER_ISSUER: hardcover.issuer,
    PUBLIC_URL: pipe(
      Option.fromNullishOr(deployment.domain),
      Option.map((host) => `https://${host}`),
      Option.getOrElse(() => ""),
    ),
  }
}

const Worker = CloudflareWorker(
  "HardcoverOAuthMcp",
  Effect.gen(function* buildWorker() {
    const deployment = yield* Deployment
    // The Markdown pages in site/routes.ts, served as static assets ahead of the Worker.
    const site = yield* Build("Site", {
      command: "bun astro build",
      env: { ASTRO_TELEMETRY_DISABLED: "1" },
      memo: { include: ["site/**", "astro.config.ts", ...SITE_FILES], lockfile: true },
      outdir: "dist/site",
    })
    const props = {
      assets: { directory: site.outdir, hash: site.hash.output },
      compatibility: {
        date: "2026-10-01",
        // Client ID Metadata Documents are fetched from client-supplied URLs. This flag keeps those
        // Fetches off private networks.
        flags: deployment.allowPrivateFetch === true ? [] : [PUBLIC_FETCH_FLAG],
      },
      crons: ["17 4 * * *"],
      env: Struct.assign(sharedEnv, deploymentEnv(deployment)),
      main: "./src/worker.ts",
      name: WORKER_NAME,
      observability: {
        enabled: true,
        issues: { enabled: true },
        logs: { enabled: true, invocationLogs: true },
        // The sign-in callback's query string carries Hardcover's one-time code; logs and traces keep only the path.
        redactQueryString: true,
        traces: { enabled: true },
      },
    }
    return Option.match(Option.fromNullishOr(deployment.domain), {
      onNone: () => props,
      onSome: (host) => Struct.assign(props, { domain: host, workersDev: false as const }),
    })
  }),
)

type WorkerEnv = InferEnv<typeof Worker>

/** The stack's resources and outputs, for the deployment the entrypoint provides. */
const publishStack = Effect.gen(function* publishStack() {
  const worker = yield* Worker
  return { url: worker.url.as<string>() }
})

/** The stage's entry in `DEPLOYMENTS`; a stage without one stops the deploy. */
const stageDeployment = Effect.gen(function* stageDeployment() {
  const stage = yield* Stage
  return yield* Option.match(Rec.get(DEPLOYMENTS, stage), {
    onNone: () => Effect.die(`alchemy.run.ts has no DEPLOYMENTS entry for stage "${stage}"`),
    onSome: Effect.succeed,
  })
})

/**
 * Deploys keep state in the Cloudflare account's Alchemy state store, so any signed-in machine can redeploy;
 * `alchemy dev` (local runs) keeps it in `.alchemy/` and needs no account.
 */
const stackState = Layer.unwrap(
  Effect.gen(function* chooseState() {
    const { dev } = yield* AlchemyContext
    return dev ? localState() : state()
  }),
)

export default Stack(
  "HardcoverOAuthMcp",
  {
    providers: providers(),
    state: stackState,
  },
  publishStack.pipe(Effect.provideServiceEffect(Deployment, stageDeployment)),
)

export { Deployment, HardcoverConnection, OAuthKV, publishStack }
export type { WorkerEnv }
