/**
 * The stack `alchemy dev --stage e2e` runs for the end-to-end tests: the Worker talks to the mock Hardcover, with
 * the mock's credentials, and only the mock's user may connect.
 */
import { ConfigProvider, Effect } from "effect"
import { Deployment, publishStack } from "#root/alchemy.run.ts"
import { Secrets, Stack, localState } from "alchemy"
import type { Layer } from "effect"
import { MOCK_URL } from "#test/e2e-config.ts"
import { providers } from "alchemy/Cloudflare"

/** Only the mock's credentials, not `.env`'s, which Bun also loads into the process environment. */
const credentials: Layer.Layer<never> = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ HARDCOVER_CLIENT_ID: "test-id", HARDCOVER_CLIENT_SECRET: "test-secret" }),
)

export default Stack(
  "HardcoverOAuthMcp",
  {
    providers: providers(),
    secrets: [credentials, Secrets.ProcessEnv({ disabled: true })],
    state: localState(),
  },
  publishStack.pipe(
    Effect.provideService(Deployment, {
      allowPrivateFetch: true,
      allowedUsers: ["reader"],
      hardcover: { graphqlUrl: `${MOCK_URL}/v1/graphql`, issuer: MOCK_URL },
    }),
  ),
)
