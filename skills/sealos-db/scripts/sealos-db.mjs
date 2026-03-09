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
//   init <kubeconfig_path> [api_url]  Parse kubeconfig, probe API URL, save config
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
//   profiles                         List all saved profiles
//   use <profile>                    Switch active profile

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_PATH = resolve(homedir(), '.config/sealos-db/config.json');
const API_PATH = '/api/v2alpha'; // API version — update here if the version changes

// --- config (multi-profile) ---

function loadAllConfig() {
  if (!existsSync(CONFIG_PATH)) return { active: null, profiles: {} };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    // Migrate legacy flat format → profiles format
    if (raw.apiUrl && !raw.profiles) {
      return { active: 'default', profiles: { default: { kubeconfigPath: raw.kubeconfigPath, apiUrl: raw.apiUrl } } };
    }
    return raw;
  } catch { return { active: null, profiles: {} }; }
}

function deriveProfileName(apiUrl) {
  try {
    const host = new URL(apiUrl).hostname;
    const parts = host.split('.');
    // dbprovider.usw.sailos.io → usw.sailos
    if (parts[0] === 'dbprovider' && parts.length > 2) {
      return parts.slice(1, -1).join('.');
    }
    return parts.slice(0, -1).join('.') || 'default';
  } catch { return 'default'; }
}

function writeAllConfig(all) {
  const dir = resolve(homedir(), '.config/sealos-db');
  mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(all, null, 2) + '\n');
}

function loadConfig() {
  // Priority 1: env vars
  if (process.env.API_URL) {
    return {
      apiUrl: process.env.API_URL,
      kubeconfigPath: process.env.KUBECONFIG_PATH || resolve(homedir(), '.kube/config'),
    };
  }

  // Priority 2: active profile from saved config
  const all = loadAllConfig();
  if (all.active && all.profiles[all.active]) {
    const p = all.profiles[all.active];
    if (p.apiUrl && p.kubeconfigPath) return p;
  }

  // Priority 3: error
  return null;
}

function saveConfig(kubeconfigPath, apiUrl) {
  const all = loadAllConfig();
  const name = deriveProfileName(apiUrl);
  all.profiles[name] = { kubeconfigPath, apiUrl };
  all.active = name;
  writeAllConfig(all);
  return name;
}

// --- auth ---

function getEncodedKubeconfig(path) {
  if (!existsSync(path)) {
    throw new Error(`Kubeconfig not found at ${path}`);
  }
  return encodeURIComponent(readFileSync(path, 'utf-8'));
}

// --- HTTP ---

function apiCall(method, endpoint, { apiUrl, auth, body, timeout = 30000 } = {}) {
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
      timeout,
      rejectUnauthorized: false, // Sealos clusters may use self-signed certificates
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

// --- kubeconfig parsing ---

function extractServerUrl(content) {
  // Handles quoted and unquoted server URLs:
  //   server: https://host:6443
  //   server: "https://host:6443"
  //   server: 'https://host:6443'
  const match = content.match(/server:\s*['"]?(https?:\/\/[^\s'"]+)/);
  return match ? match[1] : null;
}

function deriveApiCandidates(serverUrl) {
  const urlObj = new URL(serverUrl);
  const hostname = urlObj.hostname;
  const parts = hostname.split('.');

  const candidates = [];
  const seen = new Set();
  function add(url) {
    if (!seen.has(url)) { seen.add(url); candidates.push(url); }
  }

  // 1. dbprovider.<full-hostname>
  add(`https://dbprovider.${hostname}${API_PATH}`);

  // 2. Strip first subdomain (e.g., apiserver.usw.sailos.io → dbprovider.usw.sailos.io)
  if (parts.length > 2) {
    add(`https://dbprovider.${parts.slice(1).join('.')}${API_PATH}`);
  }

  // 3. Strip first two subdomains (for deeper hierarchies)
  if (parts.length > 3) {
    add(`https://dbprovider.${parts.slice(2).join('.')}${API_PATH}`);
  }

  return candidates;
}

async function probeApiUrl(candidates) {
  for (const apiUrl of candidates) {
    try {
      const res = await apiCall('GET', '/databases/versions', { apiUrl, timeout: 5000 });
      if (res.status === 200) return apiUrl;
    } catch { /* try next candidate */ }
  }
  return null;
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
  return res.body;
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
  // Re-fetch to return updated state
  try {
    const updated = await get(cfg, name);
    return { success: true, message: 'Database update initiated', database: updated };
  } catch {
    return { success: true, message: 'Database update initiated' };
  }
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

async function init(kubeconfigPath, manualApiUrl) {
  // 1. Resolve path
  const kcPath = kubeconfigPath.replace(/^~/, homedir());
  const absPath = resolve(kcPath);

  if (!existsSync(absPath)) {
    throw new Error(`Kubeconfig not found at ${absPath}`);
  }

  // 2. Parse kubeconfig
  const kcContent = readFileSync(absPath, 'utf-8');
  const serverUrl = extractServerUrl(kcContent);
  if (!serverUrl) {
    throw new Error('Could not find server URL in kubeconfig');
  }

  // 3. Resolve API URL — manual override or auto-probe
  let apiUrl;
  if (manualApiUrl) {
    apiUrl = manualApiUrl.replace(/\/+$/, '');
    if (!apiUrl.endsWith(API_PATH)) {
      apiUrl += API_PATH;
    }
  } else {
    const candidates = deriveApiCandidates(serverUrl);
    apiUrl = await probeApiUrl(candidates);
    if (!apiUrl) {
      throw new Error(
        `Could not auto-detect API URL from server: ${serverUrl}\n` +
        `Tried: ${candidates.join(', ')}\n` +
        `Specify manually: node sealos-db.mjs init ${kubeconfigPath} <api_url>\n` +
        `Example: node sealos-db.mjs init ${kubeconfigPath} https://dbprovider.your-domain.com`
      );
    }
  }

  // 4. Save config (auto-derives profile name from domain)
  const profileName = saveConfig(absPath, apiUrl);

  // 5. Fetch versions and databases
  const cfg = { apiUrl, kubeconfigPath: absPath };
  const versions = await listVersions(cfg);

  let databases = [];
  try {
    databases = await list(cfg);
  } catch (e) {
    // Auth might fail but versions worked — return partial result
    return { apiUrl, kubeconfigPath: absPath, profileName, versions, databases: null, authError: e.message };
  }

  return { apiUrl, kubeconfigPath: absPath, profileName, versions, databases };
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
    console.error('Commands: init|list-versions|list|get|create|create-wait|update|delete|start|pause|restart|enable-public|disable-public|profiles|use');
    process.exit(1);
  }

  try {
    let result;

    switch (cmd) {
      case 'init': {
        if (!args[0]) throw new Error('Usage: node sealos-db.mjs init <kubeconfig_path> [api_url]');
        result = await init(args[0], args[1]);
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

      case 'profiles': {
        const all = loadAllConfig();
        result = {
          active: all.active,
          profiles: Object.entries(all.profiles).map(([name, cfg]) => ({
            name,
            apiUrl: cfg.apiUrl,
            kubeconfigPath: cfg.kubeconfigPath,
            active: name === all.active,
          })),
        };
        break;
      }

      case 'use': {
        const name = requireName(args);
        const all = loadAllConfig();
        if (!all.profiles[name]) {
          const available = Object.keys(all.profiles).join(', ');
          throw new Error(`Profile '${name}' not found. Available: ${available || '(none)'}`);
        }
        all.active = name;
        writeAllConfig(all);
        result = { active: name, ...all.profiles[name] };
        break;
      }

      default:
        throw new Error(`Unknown command '${cmd}'. Commands: init|list-versions|list|get|create|create-wait|update|delete|start|pause|restart|enable-public|disable-public|profiles|use`);
    }

    if (result !== undefined) output(result);
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();
