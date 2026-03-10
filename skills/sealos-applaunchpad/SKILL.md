---
name: sealos-applaunchpad
description: >-
  Use when someone needs to deploy or manage containerized applications on Sealos:
  create, list, update, scale, delete, start, stop, pause, restart apps,
  check status, manage ports, env vars, storage, config maps.
  Triggers on "deploy my app", "create an app on sealos", "scale my app",
  "I need to deploy a container", "stop my app", "show my apps".
---

## Interaction Principle — MANDATORY

**NEVER output a question as plain text. ALWAYS use `AskUserQuestion` with an `options` array.**

This is a hard rule with zero exceptions:
- Every time you need user input → call `AskUserQuestion` with `options`
- Do NOT write a question as text output and wait — the user MUST see clickable options
- Do NOT output explanatory prose and then ask a question as text — call `AskUserQuestion` instead
- Keep text output before `AskUserQuestion` to one short sentence max (status update only)

**BAD** (never do this):
```
Please save your Sealos kubeconfig to a file and tell me the path.
Download from Sealos Console > Settings > Kubeconfig...
```

**GOOD** (always do this):
```
AskUserQuestion(header="Kubeconfig", question="Where is your Sealos kubeconfig?", options=[...])
```

`AskUserQuestion` always adds an implicit "Other / Type something" option automatically,
so the user can still type custom input when none of the options fit.

**Free-text matching:** When the user types free text instead of clicking an option,
match it to the closest option by intent. Examples:
- "show all apps", "all apps" → treat as "Show all apps"
- "deploy", "create" → treat as the Create option
- "stop" → treat as the Pause option (AppLaunchpad uses "pause")

Never re-ask the same question because the wording didn't match exactly.

## Fixed Execution Order

**ALWAYS follow these steps in this exact order. No skipping, no reordering.**

```
Step 0: Check Memory       (try to restore auth from previous session)
Step 1: Authenticate        (only if Step 0 has no valid memory)
Step 2: Route               (determine which operation the user wants)
Step 3: Execute operation   (follow the operation-specific steps below)
Step 4: Update Memory       (save state for next session)
```

---

## Step 0: Check Memory

Check for a memory file named `sealos-applaunchpad.md` in the project's auto memory directory
(the path is provided by the system environment, e.g. `~/.claude/projects/.../memory/sealos-applaunchpad.md`).

**If memory file exists and contains `kubeconfig_path` + `api_url`:**
1. Verify the kubeconfig file still exists at the saved path
2. If memory has a `profile` field, ensure the script's active profile matches:
   run `node scripts/sealos-applaunchpad.mjs profiles` and compare. If different,
   run `node scripts/sealos-applaunchpad.mjs use <profile>` to switch first.
3. Run `node scripts/sealos-applaunchpad.mjs list` (auto-loads config) to test auth
4. If works → skip Step 1. Greet with context:
   > Connected to Sealos (`{profile}`). You have N apps running.
5. If fails (401, file missing) → proceed to Step 1, mention the token may have expired

**If no memory file or missing auth fields** → proceed to Step 1.

---

## Step 1: Authenticate

Run this step only if Step 0 found no valid memory.

### 1a. Get kubeconfig file path

Check if these common paths exist: `~/.kube/config`, `~/sealos-kc.yaml`, `~/kubeconfig.yaml`

**STOP. Do NOT read any kubeconfig file yet. Do NOT proceed to Step 1b.**
**You MUST call `AskUserQuestion` first and WAIT for the user to confirm which file.**

`AskUserQuestion`:
- header: "Kubeconfig"
- question: "Where is your Sealos kubeconfig file?"
- useDescription: "Download from Sealos Console > Settings > Kubeconfig, save to a file. Do not paste content."
- options: list any of the above paths that **exist on disk**, then always add:
  - `"I'll save it now — tell me where"`
- Example (if `~/.kube/config` exists):
  ```
  ["~/.kube/config", "I'll save it now — tell me where"]
  ```
- Example (if none exist):
  ```
  ["I'll save it now — tell me where"]
  ```

**Only after the user picks or types a path → proceed to Step 1b.**

**If user pastes kubeconfig content instead of a path:** Explain that the API needs the
original YAML byte-for-byte and terminal pasting corrupts it. Ask them to save to a file.

### 1b. Validate identity

Read the kubeconfig file. Parse the YAML to extract:
- `server` URL (from `clusters[0].cluster.server`)
- **User context name** (from `users[0].name` or `contexts[0].context.user`)

If user is `kubernetes-admin` or any cluster admin identity → **STOP**:
> This is a cluster admin kubeconfig. The AppLaunchpad API needs a Sealos user kubeconfig
> (download from Sealos Console > Settings > Kubeconfig).

### 1c. Init (derive API URL + validate connection)

Run `node scripts/sealos-applaunchpad.mjs init <kubeconfig_path>`. This single command:
- Parses the kubeconfig, extracts the server URL
- **Auto-probes** candidate API URLs (tries `applaunchpad.<domain>` with subdomain
  variations) using auth (all endpoints require auth)
- Saves config to `~/.config/sealos-applaunchpad/config.json`
- Lists apps to verify auth

**If auto-detection fails** (error mentions "Could not auto-detect API URL"):
`AskUserQuestion`:
- header: "API URL"
- question: "Could not auto-detect API URL. What is your Sealos domain?"
- useDescription: "Find it in your browser URL bar when logged into Sealos Console (e.g., usw.sailos.io)"
- options: ["I'll check my Sealos Console"]

Then run: `node scripts/sealos-applaunchpad.mjs init <kubeconfig_path> https://applaunchpad.<domain>`

**If `init` returns an `authError`** (has `apps: null`):
The API URL is correct but the kubeconfig token has expired. Guide the user:

1. Display:
   > API connection successful (`{profileName}`), but your kubeconfig token has expired.
2. `AskUserQuestion`:
   - header: "Re-authenticate"
   - question: "Download a fresh kubeconfig to reconnect?"
   - useDescription: "Go to Sealos Console → Settings → Kubeconfig → Download, save to a file."
   - options:
     1. "I've downloaded it — pick file"
     2. "Cancel"
3. After user provides new path → re-run `init` with the new kubeconfig path.
4. Clear the memory file's `Auth` section so stale credentials aren't reused.

**If `init` succeeds fully** (has `apps`, no `authError`):
The response includes `apps` and `profileName`. Display:
> Connected to Sealos (`{profileName}`). You have N apps.

Use `apps` in Step 3 instead of making a separate `list` call.

---

## Step 2: Route

Determine the operation from user intent:

| Intent | Operation |
|--------|-----------|
| "create/deploy/launch an app" | Create |
| "list/show my apps" | List |
| "check status/details" | Get |
| "scale/resize/update/change" | Update |
| "delete/remove app" | Delete |
| "start" | Action (start) |
| **"stop/pause"** | **Action (pause)** — explain: AppLaunchpad uses "pause" (scales to zero) |
| "restart" | Action (restart) |
| "expand storage/add volume" | Storage Update |
| "switch cluster/profile/account" | Profile |

If ambiguous, ask one clarifying question.

---

## Step 3: Operations

### Create

**3a. Scan project context**

Check the working directory for project files (package.json, go.mod, requirements.txt,
Cargo.toml, Dockerfile, docker-compose.yml, etc.) to understand the tech stack.

**3b. Ask name first**

`AskUserQuestion`:
- header: "Name"
- question: "App name?"
- options: generate 2-3 name suggestions from project dir name.
  If a name already exists (from list), avoid it and note the conflict.
- Constraint: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, max 63 chars

**3c. Detect image**

- If Dockerfile exists: suggest building and pushing to a registry, or use detected base image
- If docker-compose.yml exists: parse image field
- If neither: recommend from `references/defaults.md` image table based on tech stack

**3d. Show recommended config and confirm**

Read `references/defaults.md` for resource presets and image recommendations.

Auto-resolve config from context:
- User's request (e.g., "deploy my Next.js app" → node:20-slim, port 3000)
- Project tech stack from 3a
- Scale hints (e.g., "production app" → higher resources)
- Memory preferences (e.g., last used image)

Display the **recommended config summary**:

```
App config:

  Name:      my-app
  Image:     nginx:alpine
  CPU:       0.2 Core(s)
  Memory:    0.5 GB
  Scaling:   1 replica(s)
  Ports:     80/http (public)
  Env:       0 variable(s)
  Storage:   0 volume(s)
  ConfigMap: 0 file(s)
```

Then `AskUserQuestion`:
- header: "Config"
- question: "Create with this config?"
- options:
  1. "Create now (Recommended)" — accept all, proceed to 3e
  2. "Customize" — go to 3d-customize flow

**3d-customize: Pick fields to change, then configure only those**

`AskUserQuestion`:
- header: "Customize"
- question: "Which fields do you want to change?"
- multiSelect: true
- options: **(max 4 items)** — group into 4:
  - "Image & Command — {current_image}"
  - "Resources (CPU, Memory, Scaling) — {cpu}C / {mem}GB / {replicas}rep"
  - "Networking (Ports) — {port_summary}"
  - "Advanced (Env, ConfigMap, Storage)"

When **"Image & Command"** selected:
- Ask for imageName
- If private registry needed: ask username, password, serverAddress
- If launch command needed: ask command and args

When **"Resources"** selected → ask sequentially:

**CPU** → `AskUserQuestion`:
- header: "CPU"
- question: "CPU cores? (0.1-32)"
- options: `0.2 (current), 0.5, 1, 2` cores. Mark current with "(current)".

**Memory** → `AskUserQuestion`:
- header: "Memory"
- question: "Memory? (0.1-32 GB)"
- options: `0.5 (current), 1, 2, 4` GB. Mark current with "(current)".

**Scaling** → `AskUserQuestion`:
- header: "Scaling"
- question: "Fixed replicas or auto-scaling (HPA)?"
- options:
  1. "Fixed replicas (current)" → ask replica count
  2. "Auto-scaling (HPA)" → ask target metric, value%, min, max

If user explicitly mentions GPU or project context indicates ML/AI workload:
**GPU** → `AskUserQuestion`:
- header: "GPU"
- question: "GPU type?"
- options: `A100, V100, T4, Skip`

When **"Networking"** selected:
- Ask for port number, protocol (show enum: http, grpc, ws, tcp, udp, sctp)
- If protocol is http/grpc/ws: ask isPublic toggle
- Note: isPublic is only effective for http/grpc/ws protocols

When **"Advanced"** selected:
- Ask about env variables (name=value pairs)
- Ask about configMap files (path + content)
- Ask about storage volumes (name, path, size)

After all fields, re-display the updated config summary and `AskUserQuestion`:
- header: "Config"
- question: "Create with this config?"
- options:
  1. "Create now (Recommended)"
  2. "Customize" — re-run the customize flow

**3e. Create and wait**

Build JSON body and run `node scripts/sealos-applaunchpad.mjs create-wait '<json>'`.
This creates the app and polls until `running` (timeout 2 minutes).

**3f. Show access URLs**

For public http/grpc/ws ports, display access URLs from the response:
- `publicAddress` from each port in the response
- `privateAddress` for internal access

---

### List

Run `node scripts/sealos-applaunchpad.mjs list`. Format as table:

```
Name            Image           Status    CPU   Mem    Replicas  Ports
my-app          nginx:alpine    running   0.2   0.5GB  1        80/http (public)
api-server      node:20-slim    running   1     2GB    3        3000/http (public)
```

Highlight abnormal statuses (error, waiting, pause).

---

### Get

If no name given, run List first, then `AskUserQuestion` with app names as options
(header: "App", question: "Which app?").

Run `node scripts/sealos-applaunchpad.mjs get {name}`. Display:
- name, image, status, quota (cpu, memory, replicas/hpa, gpu)
- ports with public/private addresses
- env variables, configMap, storage
- resourceType, kind, createdAt, upTime
- Access URLs for public ports

---

### Update

**3a.** If no name given → List, then `AskUserQuestion` to pick which app
(options = app names from list).

**3b.** Run `node scripts/sealos-applaunchpad.mjs get {name}`, show current specs.

**3c.** `AskUserQuestion` (header: "Update", question: "What to change?", multiSelect: true):
- "Image & Command"
- "Resources (CPU, Memory, Scaling)"
- "Networking (Ports)"
- "Advanced (Env, ConfigMap, Storage)"

For each selected field, follow up with `AskUserQuestion` offering allowed values as options.
See `references/api-reference.md` for allowed update values:
- CPU: 0.1, 0.2, 0.5, 1, 2, 3, 4, 8
- Memory: 0.1, 0.5, 1, 2, 4, 8, 16

**3d.** **WARN**: ports, env, configMap, storage are **COMPLETE REPLACEMENT** —
must include ALL items to keep. Items not listed will be deleted.

Show before/after diff, then `AskUserQuestion` (header: "Confirm",
question: "Apply these changes?"):
- "Apply (Recommended)"
- "Edit again"
- "Cancel"

**3e.** Run `node scripts/sealos-applaunchpad.mjs update {name} '{json}'`.

---

### Delete

**This is destructive. Maximum friction.**

**3a.** If no name given → List, then `AskUserQuestion` to pick which app.

**3b.** Run `node scripts/sealos-applaunchpad.mjs get {name}`, show full details.

**3c.** Explain consequences:
- The app and all its resources (pods, services, ingress) will be permanently deleted
- Storage volumes may be lost
- Public URLs will stop working immediately

**3d.** `AskUserQuestion`:
- header: "Confirm Delete"
- question: "Type `{name}` to permanently delete this app"
- options: ["Cancel"] — do NOT include the app name as a clickable option.
  The user must type the exact name via "Type something" to confirm.

If user types the correct name → proceed to 3e.
If user types something else → reply "Name doesn't match" and re-ask.
If user clicks Cancel → abort.

**3e.** Run `node scripts/sealos-applaunchpad.mjs delete {name}`.

---

### Action (Start/Pause/Restart)

**3a.** If no name given → List, then `AskUserQuestion` to pick which app.

**3b.** `AskUserQuestion` to confirm (header: "Action", question: "Confirm {action} on {name}?"):
- "{Action} now"
- "Cancel"

**Important:** "stop" maps to "pause". Explain to the user:
> AppLaunchpad uses "pause" which scales your app to zero replicas. Your configuration is preserved.

**3c.** Run `node scripts/sealos-applaunchpad.mjs {action} {name}`.
**3d.** For `start`: poll `node scripts/sealos-applaunchpad.mjs get {name}` until `running`.

---

### Storage Update

**3a.** If no name given → List, then `AskUserQuestion` to pick which app.

**3b.** Run `node scripts/sealos-applaunchpad.mjs get {name}` to verify current storage state.

**3c.** Ask what to add/expand:
- Show current storage volumes
- This is **incremental merge** — only specify new or expanded volumes
- Name is auto-generated from path (don't send name field)

**3d.** **Expand only** — warn if user tries to shrink:
> Storage volumes can only be expanded, never shrunk (Kubernetes limitation).

**3e.** Warn about potential downtime during storage operations.

**3f.** Run `node scripts/sealos-applaunchpad.mjs update-storage {name} '{"storage":[...]}'`.

---

### Profile (Switch Cluster)

The script supports multiple Sealos clusters via named profiles. Each `init` auto-creates
a profile named after the domain (e.g., `usw.sailos`). Existing profiles are preserved.

**List profiles:** Run `node scripts/sealos-applaunchpad.mjs profiles`. Display as table:

```
Profile       API URL                                              Active
usw.sailos    https://applaunchpad.usw.sailos.io/api/v2alpha       ✓
cn.sailos     https://applaunchpad.cn.sailos.io/api/v2alpha
```

**Switch profile:** `AskUserQuestion` with profile names as options
(header: "Profile", question: "Which cluster?"). Then run:
`node scripts/sealos-applaunchpad.mjs use <name>`

**Add new cluster:** Run Step 1 (Authenticate) with a new kubeconfig.
`init` auto-creates a new profile from the domain without removing existing ones.

---

## Step 4: Update Memory

After every successful operation, update the memory file named `sealos-applaunchpad.md`
in the project's auto memory directory.

**What to save and when:**

| Event | Save |
|-------|------|
| Successful auth (Step 1) | `profile`, `kubeconfig_path`, `api_url`, `namespace` |
| After create | Add app to list |
| After delete | Remove app from list |
| After list/get | Refresh apps list with current state |

**Memory file format:**

```markdown
# Sealos AppLaunchpad Memory

## Auth
- profile: usw.sailos
- kubeconfig_path: ~/sealos-kc.yaml
- api_url: https://applaunchpad.usw.sailos.io/api/v2alpha
- namespace: ns-xxx

## Apps
- my-app: nginx:alpine, running, 0.2C/0.5GB/1rep
- api-server: node:20-slim, running, 1C/2GB/3rep

## Preferences
- preferred_image: node:20-slim
```

**Rules:**
- Create the file if it doesn't exist
- Use Edit tool to update specific sections, don't overwrite the whole file unnecessarily
- The apps list is a cache for quick reference — always verify with live API when accuracy matters

---

## Script

Single entry point: `scripts/sealos-applaunchpad.mjs` (relative to this skill's directory).
Zero external dependencies (Node.js only).
TLS certificate verification is disabled (`rejectUnauthorized: false`) because Sealos
clusters may use self-signed certificates. See `references/api-reference.md` for details.

**The script is bundled with this skill — do NOT check if it exists. Just run it.**

**Path resolution:** This skill's directory is listed in "Additional working directories"
in the system environment. Use that path to locate the script. For example, if the
additional working directory is `/Users/x/project/.claude/skills/sealos-applaunchpad/scripts`,
then run: `node /Users/x/project/.claude/skills/sealos-applaunchpad/scripts/sealos-applaunchpad.mjs <command>`.

**Config auto-load priority:**
1. `KUBECONFIG_PATH` + `API_URL` env vars (backwards compatible)
2. `~/.config/sealos-applaunchpad/config.json` (saved by `init`)
3. Error with hint to run `init`

```bash
# Use the absolute path from "Additional working directories" — examples below use SCRIPT as placeholder
SCRIPT="/path/from/additional-working-dirs/sealos-applaunchpad.mjs"

# First-time setup — auto-probes API URL (needs auth), saves config, returns apps
node $SCRIPT init ~/sealos-kc.yaml

# First-time setup with manual API URL (if auto-probe fails)
node $SCRIPT init ~/sealos-kc.yaml https://applaunchpad.your-domain.com

# After init, no env vars needed — config is auto-loaded
node $SCRIPT list
node $SCRIPT get my-app
node $SCRIPT create '{"image":{"imageName":"nginx:alpine"},"quota":{"cpu":0.2,"memory":0.5,"replicas":1},"ports":[{"number":80}]}'
node $SCRIPT create-wait '{"name":"my-app","image":{"imageName":"nginx:alpine"},"quota":{"cpu":0.2,"memory":0.5,"replicas":1}}'
node $SCRIPT update my-app '{"quota":{"cpu":1,"memory":2}}'
node $SCRIPT delete my-app
node $SCRIPT start|pause|restart my-app

# Storage management (incremental merge, expand only)
node $SCRIPT update-storage my-app '{"storage":[{"path":"/var/data","size":"20Gi"}]}'

# Multi-cluster profile management
node $SCRIPT profiles               # list all saved profiles
node $SCRIPT use usw.sailos          # switch active profile
```

## Reference Files

- `references/api-reference.md` — API endpoints, resource constraints, error formats. Read first.
- `references/defaults.md` — Resource presets, image recommendations, config summary template. Read for create operations.
- `references/openapi.json` — Complete OpenAPI spec. Read only for edge cases.

## Error Handling

**Treat each error independently.** Do NOT chain unrelated errors.

| Scenario | Action |
|----------|--------|
| Kubeconfig not found | Guide user to download from Sealos Console |
| Auth error (401) | Kubeconfig expired. Follow the `authError` recovery flow in Step 1c: display expiry message, guide user to re-download from Sealos Console → Settings → Kubeconfig, re-run `init`, clear memory auth section. |
| Name conflict (409) | Suggest alternative name |
| Invalid image | Check image name and registry access |
| Storage shrink | Refuse, K8s limitation |
| Creation timeout (>2 min) | Offer to keep polling or check console |
| "namespace not found" (500) | Cluster admin kubeconfig; need Sealos user kubeconfig |

## Rules

- NEVER ask a question as plain text — ALWAYS use `AskUserQuestion` with options
- NEVER read `~/.kube/config` or any kubeconfig without asking the user first via `AskUserQuestion`
- NEVER run `test -f` on the skill script — it is always present, just run it
- NEVER accept pasted kubeconfig — API requires exact original YAML; pasting corrupts it
- NEVER write kubeconfig to `~/.kube/config` — may overwrite user's existing config
- NEVER echo kubeconfig content to output
- NEVER delete without explicit name confirmation
- NEVER construct HTTP requests inline — always use `scripts/sealos-applaunchpad.mjs`
- NEVER update without GET first (complete replacement semantics for ports/env/configMap/storage)
- Storage can only expand, never shrink
- "stop" always maps to "pause" — explain this to the user
- Ports, env, configMap, storage in update are COMPLETE REPLACEMENT — include all items to keep
