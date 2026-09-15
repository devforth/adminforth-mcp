# AdminForth MCP

`@adminforth/mcp` exposes the AdminForth API tool surface as an authenticated remote MCP server. Each MCP auth secret belongs to one AdminForth user, so resource permissions and hooks are preserved.

The server identifies itself to agents using the configured AdminForth `brandName`. An optional `adminPanelOrigin` can distinguish deployments further; the plugin combines it with the AdminForth `baseUrl`.

Install with:

```bash
pnpm add @adminforth/mcp
```

See the [AdminForth MCP documentation](https://adminforth.dev/docs/tutorial/Plugins/mcp/) for the auth secret table and plugin configuration.
