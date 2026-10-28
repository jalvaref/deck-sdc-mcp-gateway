import { createHash, timingSafeEqual } from 'node:crypto';

const repository = process.env.GITHUB_REPOSITORY ?? 'jalvaref/drupal-sdc-landing-demo';
const baseBranch = process.env.GITHUB_BASE_BRANCH ?? 'main';
const workflow = process.env.HANDOFF_WORKFLOW ?? 'sdc-handoff.yml';
const dryRun = process.env.MCP_DRY_RUN !== 'false';

const tools = [
  { name: 'validate_landing_run', description: 'Valida una ejecución aprobada antes de escribir.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } },
  { name: 'create_github_pull_request', description: 'Crea una rama, commit y pull request en el repositorio permitido.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, branch: { type: 'string' }, files: { type: 'array' }, confirm: { type: 'boolean' } }, required: ['run_id', 'files', 'confirm'] } },
  { name: 'deploy_pantheon_dev', description: 'Solicita el workflow de despliegue hacia Pantheon Dev.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['run_id', 'confirm'] } },
  { name: 'import_drupal_draft', description: 'Solicita la importación de la landing como draft en Drupal.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, confirm: { type: 'boolean' } }, required: ['run_id', 'confirm'] } }
];

function authorized(request: Request) {
  const expected = process.env.MCP_SHARED_SECRET;
  if (!expected) return process.env.NODE_ENV !== 'production';
  const received = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const a = createHash('sha256').update(received).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function github(path: string, init: RequestInit = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN no configurado.');
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json', ...(init.headers ?? {}) }, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function dispatch(action: string, runId: string) {
  if (dryRun) return { dry_run: true, action, run_id: runId, repository, workflow };
  await github(`/repos/${repository}/actions/workflows/${workflow}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: baseBranch, inputs: { action, run_id: runId } }) });
  return { requested: true, action, run_id: runId, repository, workflow };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const runId = String(args.run_id ?? '');
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(runId)) throw new Error('run_id inválido.');
  if (name === 'validate_landing_run') return dispatch('validate', runId);
  if (name === 'create_github_pull_request') { if (args.confirm !== true) throw new Error('La creación de PR requiere confirm=true.'); return { status: 'pending_implementation', note: 'La escritura de archivos se habilitará junto con la GitHub App del gateway.', run_id: runId, repository, baseBranch }; }
  if (name === 'deploy_pantheon_dev') { if (args.confirm !== true) throw new Error('El despliegue requiere confirm=true.'); return dispatch('deploy_pantheon_dev', runId); }
  if (name === 'import_drupal_draft') { if (args.confirm !== true) throw new Error('La importación requiere confirm=true.'); return dispatch('import_drupal_draft', runId); }
  throw new Error(`Herramienta no permitida: ${name}`);
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' } }, { status: 401 });
  const message = await request.json();
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
  if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'totalenergies-sdc-mcp-gateway', version: '0.1.0' } } });
  if (message.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: message.id, result: { tools } });
  if (message.method === 'tools/call') { try { const result = await callTool(message.params?.name, message.params?.arguments ?? {}); return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } }); } catch (error) { return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Error desconocido' } }, { status: 400 }); } }
  return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }, { status: 404 });
}
