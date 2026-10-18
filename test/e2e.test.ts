/**
 * End-to-end: the real Worker in workerd (`alchemy dev`), a mock Hardcover,
 * and a scripted MCP client. Opt-in because it starts workerd:
 *
 *   mise run test:e2e
 */
import { accountLimit, refusal, registrationLimit, stepUp } from "#test/e2e-limits.ts"
import { afterAll, beforeAll, describe, test } from "bun:test"
import { authorization, discovery, legacySession, staticPages, toolsOverCurrentProtocol } from "#test/e2e-cases.ts"
import { hardcoverRefresh, mcpRefresh, revocation } from "#test/e2e-refresh.ts"
import { harnessLayer, skipped, waitForWorker } from "#test/e2e-setup.ts"
import { ManagedRuntime } from "effect"

const HOOK_TIMEOUT = 120_000
const LIMIT_TIMEOUT = 60_000

const runtime = ManagedRuntime.make(harnessLayer)

const connectionTests = (): void => {
  test("publishes discovery metadata", () => runtime.runPromise(discovery))
  test("authorizes through consent and Hardcover", () => runtime.runPromise(authorization))
  test("lists tools over 2026-07-28 and calls one", () => runtime.runPromise(toolsOverCurrentProtocol))
  test("serves 2025-06-18 clients in a session held by the connection's Durable Object", () => runtime.runPromise(legacySession))
  test("serves the README, privacy notice, terms, and security policy as static pages, styled like the consent page", () =>
    runtime.runPromise(staticPages))
}

const tokenTests = (): void => {
  test("refreshes the Hardcover token once on 401 and keeps working", () => runtime.runPromise(hardcoverRefresh))
  test("refreshes MCP tokens", () => runtime.runPromise(mcpRefresh))
  test("sends the client back to authorization once Hardcover access is revoked", () => runtime.runPromise(revocation))
}

const limitTests = (): void => {
  test("asks for step-up when a tool needs a scope the token lacks", () => runtime.runPromise(stepUp))
  test("returns access_denied when the user denies consent", () => runtime.runPromise(refusal))
  // Last: these use up the minute's allowance.
  test("limits MCP requests per Hardcover account", () => runtime.runPromise(accountLimit), LIMIT_TIMEOUT)
  test("limits client registration per IP", () => runtime.runPromise(registrationLimit))
}

describe.skipIf(skipped)("end to end", () => {
  beforeAll(() => runtime.runPromise(waitForWorker), HOOK_TIMEOUT)
  afterAll(() => runtime.dispose())
  connectionTests()
  tokenTests()
  limitTests()
})
