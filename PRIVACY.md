<!-- toc -->

# Privacy

This notice covers the public instance at **hardcover.benjuntilla.com**, a Model Context Protocol (MCP) server run by Ben Juntilla. If you run your own copy, edit this file; it's what your deployment shows at `/privacy`.

## Data collected

The server stores no book data. Your library, reviews, lists, and everything else you ask for pass straight through from Hardcover to your MCP client.

You sign in on Hardcover's own site, so your password never reaches this server.

There are no analytics, ads, or trackers. The pages run no scripts and load nothing from other sites.

- **Your connection.** When you connect an MCP client, the server keeps your Hardcover access and refresh tokens, user id, and username. It also notes when you connected and when you last used the connection. These live in a Cloudflare Durable Object dedicated to that connection and never reach your MCP client.
- **The authorization grant.** Cloudflare KV holds the grant your MCP client received. A pseudonym of your Hardcover user id names it. It has your username, the permissions you approved, and hashes of the client's tokens. It also holds your user id, Supporter status, and librarian roles, encrypted with the client's token.
- **MCP client registrations.** The name, website, and redirect addresses an MCP client registers with.
- **Cookies.** The consent page sets cookies that tie the sign-in to your browser and remember which apps you already approved here.
- **Logs.** Cloudflare records request logs and traces for this server. They include your IP address and country, and each request's address (without its query string), method, status, timing, and errors. They also include request headers, such as your MCP client's name and the tool it called. Cloudflare redacts the authorization and cookie headers, and the logs leave out request bodies, responses, and tokens. Traces name the stored records each request uses, which carry only the pseudonym. Cloudflare's error tracking groups unexpected errors, without their request data.
- **Rate limits.** The server counts requests per IP address and per Hardcover account, without saving the counts.

## Sharing

Only the operator can see this data, through the Cloudflare account that hosts the server. The operator doesn't sell or share any of it. Hardcover sees your requests as coming from this app, under the permissions you approved.

## Retention

- After **150 days** without use, the server revokes a connection at Hardcover and deletes it.
- A daily job purges expired grants and tokens from KV.
- Cloudflare keeps logs for up to 7 days.

## Your choices

- **Pick permissions** on the consent page. Your client doesn't see tools that need a permission you didn't grant.
- **Disconnect** any time from Hardcover under **Account → API → Authorized apps**. The server deletes your connection the next time your client uses it, or after 150 days if it never does. Your client then has to sign in again.
- **Ask** the operator for a copy of what the server holds about you, or to delete it, through the contact below.

## Contact

Email [ben@benjuntilla.com](mailto:ben@benjuntilla.com).
