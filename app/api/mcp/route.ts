import { createHash, timingSafeEqual } from 'node:crypto';

const repository = process.env.GITHUB_REPOSITORY ?? 'jalvaref/drupal-sdc-landing-demo';
const baseBranch = process.env.GITHUB_BASE_BRANCH ?? 'main';
const workflow = process.env.HANDOFF_WORKFLOW ?? 'sdc-handoff.yml';
const dryRun = process.env.MCP_DRY_RUN !== 'false';
const maxFiles = 100;
const maxFileBytes = 2_000_000;
const maxTotalBytes = 10_000_000;

const tools = [
  { name: 'validate_landing_run', description: 'Valida una ejecución aprobada antes de escribir.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } },
  { name: 'create_github_pull_request', description: 'Crea una rama, commit y pull request en el repositorio permitido.', inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, branch: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, content_base64: { type: 'string' } }, required: ['path'] } }, confirm: { type: 'boolean' } }, required: ['run_id', 'files', 'confirm'] } },
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

function branchName(input: unknown, runId: string) {
  const branch = String(input || `codex/landing-${runId}`);
  if (!/^codex\/landing-[a-z0-9][a-z0-9-]{2,80}$/.test(branch)) throw new Error('branch inválida; debe usar codex/landing-<slug>.');
  return branch;
}

function normalizeFiles(input: unknown) {
  if (!Array.isArray(input) || input.length === 0 || input.length > maxFiles) throw new Error(`files debe contener entre 1 y ${maxFiles} archivos.`);
  let total = 0;
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`files[${index}] inválido.`);
    const item = raw as { path?: unknown; content?: unknown; content_base64?: unknown };
    const path = String(item.path ?? '');
    if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('..') || /^[A-Za-z]:/.test(path)) throw new Error(`Ruta no permitida: ${path}`);
    const hasText = typeof item.content === 'string';
    const hasBase64 = typeof item.content_base64 === 'string';
    if (hasText === hasBase64) throw new Error(`files[${index}] debe incluir content o content_base64, pero no ambos.`);
    const contentBase64 = hasBase64 ? item.content_base64 as string : Buffer.from(item.content as string, 'utf8').toString('base64');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4 !== 0) throw new Error(`content_base64 inválido en ${path}.`);
    const bytes = Buffer.from(contentBase64, 'base64').byteLength;
    if (bytes > maxFileBytes) throw new Error(`${path} supera el límite de ${maxFileBytes} bytes.`);
    total += bytes;
    if (total > maxTotalBytes) throw new Error(`El conjunto de archivos supera el límite de ${maxTotalBytes} bytes.`);
    return { path, contentBase64, bytes };
  });
}

async function createPullRequest(args: Record<string, unknown>, runId: string) {
  if (args.confirm !== true) throw new Error('La creación de PR requiere confirm=true.');
  const branch = branchName(args.branch, runId);
  const files = normalizeFiles(args.files);
  const title = String(args.title || `Landing SDC: ${runId}`);
  const body = String(args.body || `Contribución generada por el agente SDC para la ejecución ${runId}.\n\nDrupal se importará como draft tras la aprobación correspondiente.`);
  if (title.length > 200 || body.length > 20_000) throw new Error('title o body supera su límite de tamaño.');
  if (dryRun) return { dry_run: true, action: 'create_github_pull_request', run_id: runId, repository, baseBranch, branch, files: files.map(({ path, bytes }) => ({ path, bytes })), title };

  const baseRef = await github(`/repos/${repository}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef.object?.sha;
  if (!baseSha) throw new Error('No se pudo resolver la rama base en GitHub.');
  const baseCommit = await github(`/repos/${repository}/git/commits/${baseSha}`);
  const treeEntries = [];
  for (const file of files) {
    const blob = await github(`/repos/${repository}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: file.contentBase64, encoding: 'base64' }) });
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await github(`/repos/${repository}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries }) });
  const commit = await github(`/repos/${repository}/git/commits`, { method: 'POST', body: JSON.stringify({ message: title, tree: tree.sha, parents: [baseSha] }) });
  let branchExists = true;
  try { await github(`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`); } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('GitHub 404')) throw error;
    branchExists = false;
  }
  if (branchExists) await github(`/repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
  else await github(`/repos/${repository}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  const openPulls = await github(`/repos/${repository}/pulls?state=open&head=${encodeURIComponent(repository.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(baseBranch)}`);
  if (Array.isArray(openPulls) && openPulls.length > 0) {
    const existing = openPulls[0];
    return { requested: true, existing: true, action: 'create_github_pull_request', run_id: runId, repository, baseBranch, branch, commit_sha: commit.sha, pull_request: { number: existing.number, url: existing.html_url, state: existing.state } };
  }
  const pull = await github(`/repos/${repository}/pulls`, { method: 'POST', body: JSON.stringify({ title, head: branch, base: baseBranch, body }) });
  return { requested: true, action: 'create_github_pull_request', run_id: runId, repository, baseBranch, branch, commit_sha: commit.sha, pull_request: { number: pull.number, url: pull.html_url, state: pull.state } };
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
  if (name === 'create_github_pull_request') return createPullRequest(args, runId);
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
