#!/usr/bin/env node
// Sealos Database CLI - single entry point for all database operations.
// Zero external dependencies. Requires Node.js (guaranteed by Claude Code).
//
// Usage:
//   node sealos-db.mjs <command> [args...]
//
// Config priority:
//   1. KUBECONFIG_PATH + API_URL env vars (backwards compatible)
//   2. ~/.config/sealos-db/config.json (from `init`)
//   3. Error with hint to run `init`
//
// Commands:
//   init <kubeconfig_path>           Parse kubeconfig, test connection, save config
//   list-versions                    List available database versions (no auth needed)
//   list                             List all databases
//   get <name>                       Get database details and connection info
//   create <json>                    Create a new database
//   create-wait <json>               Create + poll until running (timeout 2min)
//   update <name> <json>             Update database resources
//   delete <name>                    Delete a database
//   start <name>                     Start a stopped database
//   pause <name>                     Pause a running database
//   restart <name>                   Restart a database
//   enable-public <name>             Enable public access
//   disable-public <name>            Disable public access

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = resolve(homedir(), '.config/sealos-db/config.json');

// --- config ---

function loadConfig() {
  // Priority 1: env vars
  if (process.env.API_URL) {
    return {
      apiUrl: process.env.API_URL,
      kubeconfigPath: process.env.KUBECONFIG_PATH || resolve(homedir(), '.kube/config'),
    };
  }

  // Priority 2: saved config
  if (existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (cfg.apiUrl && cfg.kubeconfigPath) return cfg;
    } catch { /* fall through */ }
  }

  // Priority 3: error
  return null;
}

function saveConfig(kubeconfigPath, apiUrl) {
  const dir = resolve(homedir(), '.config/sealos-db');
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ kubeconfigPath, apiUrl }, null, 2) + '\n');
}

// --- auth ---

function getEncodedKubeconfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Kubeconfig not found at ${path}`);
  }
  return encodeURIComponent(readFileSync(path, 'utf-8'));
}

// --- HTTP ---

function apiCall(method, endpoint, { apiUrl, auth, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiUrl + endpoint);
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const headers = {};
    if (auth) headers['Authorization'] = auth;
    if (body) headers['Content-Type'] = 'application/json';

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const opts = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 30000,
      rejectUnauthorized: false, 
    };

    const req = reqFn(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString();
        let parsed = null;
        try { parsed = JSON.parse(rawBody); } catch { parsed = rawBody || null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// --- helpers ---

function requireConfig(allowNoConfig) {
  const cfg = loadConfig();
  if (!cfg && !allowNoConfig) {
    throw new Error('No config found. Run: node sealos-db.mjs init <kubeconfig_path>');
  }
  return cfg;
}

function requireName(args) {
  if (!args[0]) throw new Error('Database name required');
  return args[0];
}

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- individual commands ---

async function listVersions(cfg) {
  // list-versions needs API_URL but no auth
  if (!cfg) throw new Error('No config found. Provide API_URL env var or run: node sealos-db.mjs init <kubeconfig_path>');
  const res = await apiCall('GET', '/databases/versions', { apiUrl: cfg.apiUrl });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function list(cfg) {
  const auth = getEncodedKubeconfig(cfg.kubeconfigPath);
  const res = await apiCall('GET', '/databases', { apiUrl: cfg.apiUrl, auth });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function get(cfg, name) {
  const auth = getEncodedKubeconfig(cfg.kubeconfigPath);
  const res = await apiCall('GET', `/databases/${name}`, { apiUrl: cfg.apiUrl, auth });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  // Return subset with key fields
  const d = res.body;
  return {
    name: d.name,
    type: d.type,
    version: d.version,
    status: d.status,
    quota: d.quota,
    connection: d.connection,
  };
}

async function create(cfg, jsonBody) {
  const body = typeof jsonBody === 'string' ? JSON.parse(jsonBody) : jsonBody;
  const auth = getEncodedKubeconfig(cfg.kubeconfigPath);
  const res = await apiCall('POST', '/databases', { apiUrl: cfg.apiUrl, auth, body });
  if (res.status !== 201) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function update(cfg, name, jsonBody) {
  const body = typeof jsonBody === 'string' ? JSON.parse(jsonBody) : jsonBody;
  const auth = getEncodedKubeconfig(cfg.kubeconfigPath);
  const res = await apiCall('PATCH', `/databases/${name}`, { apiUrl: cfg.apiUrl, auth, body });
  if (res.status !== 204) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return { success: true, message: `Database update initiated` };
}

async function del(cfg, name) {
  const auth = getEncodedKubeconfig(cfg.kubeconfigPath);
  const res = await apiCall('DELETE', `/databases/${name}`, { apiUrl: cfg.apiUrl, auth });
  if (res.status !== 204) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return { success: true, message: `Database '${name}' deleted` };
}

async function action(cfg, name, actionName) {
  const auth = getEncodedKubeconfig(cfg.kubeconfigPath);
  const res = await apiCall('POST', `/databases/${name}/${actionName}`, { apiUrl: cfg.apiUrl, auth });
  if (res.status !== 204) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  return { success: true, message: `Action '${actionName}' on '${name}' completed` };
}

// --- batch commands ---

async function init(kubeconfigPath) {
  // 1. Resolve path
  const kcPath = kubeconfigPath.replace(/^~/, homedir());
  const absPath = resolve(kcPath);

  if (!existsSync(absPath)) {
    throw new Error(`Kubeconfig not found at ${absPath}`);
  }

  // 2. Parse kubeconfig to extract server URL (regex, no YAML lib)
  const kcContent = readFileSync(absPath, 'utf-8');
  const serverMatch = kcContent.match(/server:\s*(https?:\/\/[^\s]+)/);
  if (!serverMatch) {
    throw new Error('Could not find server URL in kubeconfig');
  }
  const serverUrl = serverMatch[1];
  const urlObj = new URL(serverUrl);
  const domain = urlObj.hostname;

  // 3. Derive API URL
  const apiUrl = `https://dbprovider.${domain}/api/v2alpha`;

  // 4. Save config
  saveConfig(absPath, apiUrl);

  // 5. Test connection + fetch versions and databases
  const cfg = { apiUrl, kubeconfigPath: absPath };

  const versions = await listVersions(cfg);

  let databases = [];
  try {
    databases = await list(cfg);
  } catch (e) {
    // Auth might fail but versions worked - still return partial result
    return {
      apiUrl,
      kubeconfigPath: absPath,
      versions,
      databases: null,
      authError: e.message,
    };
  }

  return {
    apiUrl,
    kubeconfigPath: absPath,
    versions,
    databases,
  };
}

async function createWait(cfg, jsonBody) {
  // 1. Create
  const body = typeof jsonBody === 'string' ? JSON.parse(jsonBody) : jsonBody;
  const createResult = await create(cfg, body);
  const name = body.name || createResult.name;

  // 2. Poll every 5s until running (max 2 min)
  const timeout = 120000;
  const interval = 5000;
  const start = Date.now();

  let lastStatus = 'creating';
  while (Date.now() - start < timeout) {
    await sleep(interval);
    try {
      const info = await get(cfg, name);
      lastStatus = info.status;
      process.stderr.write(`Status: ${lastStatus}\n`);
      if (lastStatus === 'running') {
        return info;
      }
      if (lastStatus === 'failed') {
        throw new Error(`Database creation failed. Status: ${lastStatus}`);
      }
    } catch (e) {
      // get might fail temporarily during creation
      if (Date.now() - start > timeout) throw e;
    }
  }

  // Timeout - return last known state
  try {
    const info = await get(cfg, name);
    return { ...info, warning: `Timed out after 2 minutes. Last status: ${info.status}` };
  } catch {
    return { name, status: lastStatus, warning: 'Timed out after 2 minutes' };
  }
}

// --- main ---

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd) {
    console.error('ERROR: Command required.');
    console.error('Commands: init|list-versions|list|get|create|create-wait|update|delete|start|pause|restart|enable-public|disable-public');
    process.exit(1);
  }

  try {
    let result;

    switch (cmd) {
      case 'init': {
        if (!args[0]) throw new Error('Usage: node sealos-db.mjs init <kubeconfig_path>');
        result = await init(args[0]);
        break;
      }

      case 'list-versions': {
        const cfg = requireConfig(false);
        result = await listVersions(cfg);
        break;
      }

      case 'list': {
        const cfg = requireConfig(false);
        result = await list(cfg);
        break;
      }

      case 'get': {
        const cfg = requireConfig(false);
        const name = requireName(args);
        result = await get(cfg, name);
        break;
      }

      case 'create': {
        const cfg = requireConfig(false);
        if (!args[0]) throw new Error('JSON body required');
        result = await create(cfg, args[0]);
        break;
      }

      case 'create-wait': {
        const cfg = requireConfig(false);
        if (!args[0]) throw new Error('JSON body required');
        result = await createWait(cfg, args[0]);
        break;
      }

      case 'update': {
        const cfg = requireConfig(false);
        const name = requireName(args);
        if (!args[1]) throw new Error('JSON body required');
        result = await update(cfg, name, args[1]);
        break;
      }

      case 'delete': {
        const cfg = requireConfig(false);
        const name = requireName(args);
        result = await del(cfg, name);
        break;
      }

      case 'start':
      case 'pause':
      case 'restart':
      case 'enable-public':
      case 'disable-public': {
        const cfg = requireConfig(false);
        const name = requireName(args);
        result = await action(cfg, name, cmd);
        break;
      }

      default:
        throw new Error(`Unknown command '${cmd}'. Commands: init|list-versions|list|get|create|create-wait|update|delete|start|pause|restart|enable-public|disable-public`);
    }

    if (result !== undefined) output(result);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();
