# TotalEnergies SDC MCP Gateway

Aplicación Next.js que expone el endpoint MCP `/api/mcp` para conectar `TotalEnergies SDC Copilot` con GitHub, Pantheon Dev y Drupal.

## Estado

Esta primera versión es segura por defecto: `MCP_DRY_RUN=true`. El endpoint requiere un secreto compartido en producción y restringe el repositorio a `jalvaref/drupal-sdc-landing-demo`. Drupal solo se maneja mediante la acción `import_drupal_draft`; no existe una acción de publicación.

## Pantheon

Configura `build: next build`, `start: next start`, Node 22 y las variables del `.env.example` mediante Secrets Manager. Conecta este repositorio como un sitio Next.js independiente; el sitio Drupal permanece separado.

## Local

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Health check: `http://localhost:3000/api/health`.
MCP endpoint: `http://localhost:3000/api/mcp`.
