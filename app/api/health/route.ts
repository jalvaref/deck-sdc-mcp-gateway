export function GET() { return Response.json({ status: 'ok', service: 'totalenergies-sdc-mcp-gateway', environment: process.env.APP_ENV ?? 'local', dryRun: process.env.MCP_DRY_RUN !== 'false' }); }
