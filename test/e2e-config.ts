/**
 * Where the end-to-end run's mock Hardcover listens, shared by the harness that starts it (test/e2e-setup.ts) and the
 * stack that points the Worker at it (test/e2e.run.ts).
 */
const MOCK_PORT = 8788

/** The mock's origin, which is also its OAuth issuer. */
const MOCK_URL = `http://localhost:${MOCK_PORT}`

/**
 * Application module, not a public API.
 * @internal
 */
export { MOCK_PORT, MOCK_URL }
