---
name: sealos-db
description: >-
  Use when someone needs to manage databases on Sealos: create, list, update, scale,
  delete, start, stop, restart, check status, get connection info, or enable/disable
  public access. Triggers on "I need a database", "create a PostgreSQL on sealos",
  "scale my database", "delete the database", "show my databases",
  or "my app needs a database connection".
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
- "show all type", "all types", "show all" → treat as "Show all types"
- "show all versions", "all versions" → treat as "Show all versions"
- "pg", "postgres" → treat as the PostgreSQL option
- "mongo" → treat as the MongoDB option

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

Check for a memory file at the project's auto memory directory:
`~/.claude/projects/{project}/memory/sealos-db.md`

**If memory file exists and contains `kubeconfig_path` + `api_url`:**
1. Verify the kubeconfig file still exists at the saved path
2. Run `node scripts/sealos-db.mjs list` (auto-loads config) to test auth
3. If works → skip Step 1. Greet with context:
   > Connected to Sealos. You have N databases running.
4. If fails (401, file missing) → proceed to Step 1, mention the token may have expired

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
> This is a cluster admin kubeconfig. The DB API needs a Sealos user kubeconfig
> (download from Sealos Console > Settings > Kubeconfig).

### 1c. Init (derive API URL + validate connection)

Run `node scripts/sealos-db.mjs init <kubeconfig_path>`. This single command:
- Parses the kubeconfig, extracts the server URL, derives the API URL
- Saves config to `~/.config/sealos-db/config.json`
- Fetches available versions and lists databases

If `init` returns an `authError` → kubeconfig expired, re-download.
The `init` response includes `versions` and `databases` — use these in Step 3
instead of making separate calls.

---

## Step 2: Route

Determine the operation from user intent:

| Intent | Operation |
|--------|-----------|
| "create/deploy/set up a database" | Create |
| "list/show my databases" | List |
| "check status/connection info" | Get |
| "scale/resize/update resources" | Update |
| "delete/remove database" | Delete |
| "start/stop/restart/public access" | Action |

If ambiguous, ask one clarifying question.

---

## Step 3: Operations

### Create

**3a. Scan project context**

Check the working directory for project files (package.json, go.mod, requirements.txt,
Cargo.toml, etc.) to understand the tech stack.

**3b. Versions & existing databases**

Use versions and databases from `init` response (Step 1c). If Step 0 was used
(skipped auth), run `node scripts/sealos-db.mjs list-versions` only if needed.

**3c. Ask name first**

`AskUserQuestion`:
- header: "Name"
- question: "Database name?"
- options: generate 2-3 name suggestions from project dir + detected type
  (see `references/defaults.md` for name suffix rules).
  If a name already exists (from 1d list), avoid it and note the conflict.
- Constraint: `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`, max 63 chars

**3d. Show recommended config and confirm**

Read `references/defaults.md` for type recommendation rules, resource presets,
and termination policy defaults.

Auto-resolve config from context:
- User's request (e.g., "create a pg" → type is postgresql)
- Project tech stack from 3a (e.g., Next.js → recommend postgresql)
- Scale hints (e.g., "production database" → higher resources)
- Memory preferences (e.g., last used type)

Display the **recommended config summary** (all fields from the create API):

```
Database config:

  Name:        my-app-pg
  Type:        PostgreSQL (recommended for web apps)
  Version:     postgresql-16.4.0 (latest)
  CPU:         1 Core
  Memory:      1 GB
  Storage:     3 GB
  Replicas:    1
  Termination: delete (data volumes kept)
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
- options: **(max 4 items)** — group the 7 fields into 4:
  - "Type & Version — {current_type} {current_version}"
  - "Resources (CPU, Memory, Storage) — {cpu}C / {mem}GB / {storage}GB"
  - "Replicas — {current_replicas}"
  - "Termination — {current_policy}"

When "Type & Version" selected → ask Type (step 1), then Version (step 2).
When "Resources" selected → ask CPU (step 3), Memory (step 4), Storage (step 5) sequentially.
Fields not selected keep their current values.

**1) Type** — First output ALL available types from `list-versions` as a numbered text list.
Then `AskUserQuestion`:
- header: "Type"
- question: "Database type?"
- options: **(max 4 items)** — top 4 types for the project context
  (see `references/defaults.md`), mark current with "(current)".
  User can type any other type name/number via "Type something".
- Example options array (for a Next.js project where current is postgresql):
  ```
  ["PostgreSQL (current)",
   "MongoDB",
   "Redis",
   "MySQL"]
  ```
- After type change: auto-update version to latest for new type

**2) Version** — First output ALL available versions for the chosen type as a numbered text list.
Then `AskUserQuestion`:
- header: "Version"
- question: "Which version?"
- options: **(max 4 items)** — latest 4 versions for the chosen type from `list-versions`,
  mark latest with "(latest)".
  User can type any other version via "Type something".
- Example options array:
  ```
  ["postgresql-16.4.0 (latest)",
   "postgresql-15.7.0",
   "postgresql-14.12.0",
   "postgresql-13.15.0"]
  ```

**3) CPU** → `AskUserQuestion`:
- header: "CPU"
- question: "CPU cores? (1-8)"
- options: **(max 4 items)** — `1 (current), 2, 4, 8` cores.
  Mark current with "(current)".

**4) Memory** → `AskUserQuestion`:
- header: "Memory"
- question: "Memory? (0.1-32 GB)"
- options: **(max 4 items)** — `1 (current), 2, 4, 8` GB.
  Mark current with "(current)".

**5) Storage** → `AskUserQuestion`:
- header: "Storage"
- question: "Storage? (1-300 GB)"
- options: **(max 4 items)** — `3 (current), 10, 20, 50` GB.
  Mark current with "(current)".

**6) Replicas** → `AskUserQuestion`:
- header: "Replicas"
- question: "Replicas? (1-20)"
- options: **(max 4 items)** — `1 (current), 2, 3, 5`.
  Mark current with "(current)".

**7) Termination policy** → `AskUserQuestion`:
- header: "Termination"
- question: "Termination policy? (cannot be changed after creation)"
- options:
  1. "delete (Recommended)" — description: "Cluster removed, data volumes (PVC) kept"
  2. "wipeout" — description: "Everything removed including data, irreversible"

After all fields, re-display the updated config summary and `AskUserQuestion`:
- header: "Config"
- question: "Create with this config?"
- options:
  1. "Create now (Recommended)"
  2. "Customize" — re-run the customize flow

Constraints:
- MySQL type is `apecloud-mysql`, not `mysql`
- Termination policy is set at creation and **cannot be changed later**

**3e. Create and wait**

Build JSON body:
```json
{"name":"my-db","type":"postgresql","version":"postgresql-16.4.0","quota":{"cpu":1,"memory":1,"storage":3,"replicas":1},"terminationPolicy":"delete"}
```

Run `node scripts/sealos-db.mjs create-wait '<json>'`. This single command creates the
database and polls until `running` (timeout 2 minutes). The response includes connection info.

**3f. Show connection info and offer integration**

Display connection details (host, port, username, password, connection string).

Then `AskUserQuestion`:
- header: "Integration"
- question: "Write connection info to your project?"
- options:
  1. "Add to .env (Recommended)" — append to .env file
  2. "Add to docker-compose.yml" — add service/env vars
  3. "Auto-detect framework config" — detect and write to framework-specific config
  4. "Skip" — just show the info, don't write anything
- When writing to `.env`, append, don't overwrite.

---

### List

Run `node scripts/sealos-db.mjs list`. Format as table:

```
Name            Type        Version             Status    CPU  Mem  Storage  Replicas
my-app-db       postgresql  postgresql-14.8.0   Running   1    2GB  5GB      1
cache           redis       redis-7.0.6         Running   1    1GB  3GB      1
```

Highlight abnormal statuses (Failed, Stopped).

---

### Get

If no name given, run List first, then `AskUserQuestion` with database names as options
(header: "Database", question: "Which database?").

Run `node scripts/sealos-db.mjs get {name}`. Display: name, type, version, status, quota, connection info.

---

### Update

**3a.** If no name given → List, then `AskUserQuestion` to pick which database
(options = database names from list).

**3b.** Run `node scripts/sealos-db.mjs get {name}`, show current specs.

**3c.** `AskUserQuestion` (header: "Update", question: "What to change?", multiSelect: true):
- "CPU" / "Memory" / "Storage" / "Replicas"
- For each selected field, follow up with `AskUserQuestion` offering allowed values as options.
  See `references/api-reference.md` for allowed values per field.

**3d.** Show before/after diff, then `AskUserQuestion` (header: "Confirm",
question: "Apply these changes?"):
- "Apply (Recommended)"
- "Edit again"
- "Cancel"

**3e.** Run `node scripts/sealos-db.mjs update {name} '{json}'`.

---

### Delete

**This is destructive. Maximum friction.**

**3a.** If no name given → List, then `AskUserQuestion` to pick which database.

**3b.** Run `node scripts/sealos-db.mjs get {name}`, show full details + termination policy.

**3c.** Explain consequences:
- `delete` policy: cluster removed, data volumes kept
- `wipeout` policy: everything removed, irreversible

**3d.** Require user to type the database name to confirm. This is the ONE place
where free-text input is intentionally required for safety — do NOT offer the name as
a clickable option.

**3e.** Run `node scripts/sealos-db.mjs delete {name}`.

---

### Action (Start/Pause/Restart/Public Access)

**3a.** If no name given → List, then `AskUserQuestion` to pick which database.

**3b.** `AskUserQuestion` to confirm (header: "Action", question: "Confirm {action} on {name}?"):
- "{Action} now"
- "Cancel"
- For `enable-public`, add description warning about internet exposure.

**3c.** Run `node scripts/sealos-db.mjs {action} {name}`.
**3d.** For `start`: poll `node scripts/sealos-db.mjs get {name}` until `running`.
For `enable-public`: re-fetch and display `publicConnection`.

---

## Step 4: Update Memory

After every successful operation, update the memory file at:
`~/.claude/projects/{project}/memory/sealos-db.md`

**What to save and when:**

| Event | Save |
|-------|------|
| Successful auth (Step 1) | `kubeconfig_path`, `api_url`, `namespace` |
| After create | Add database to list, update `preferred_type` |
| After delete | Remove database from list |
| After list/get | Refresh databases list with current state |

**Memory file format:**

```markdown
# Sealos DB Memory

## Auth
- kubeconfig_path: ~/sealos-kc.yaml
- api_url: https://dbprovider.usw.sailos.io/api/v2alpha
- namespace: ns-xxx

## Databases
- my-app-pg: postgresql, running, Dev tier
- cache: redis, running, Small tier

## Preferences
- preferred_type: postgresql
```

**Rules:**
- Create the file if it doesn't exist
- Use Edit tool to update specific sections, don't overwrite the whole file unnecessarily
- The databases list is a cache for quick reference — always verify with live API when accuracy matters

---

## Script

Single entry point: `scripts/sealos-db.mjs` (relative to this skill's directory).
Zero external dependencies (Node.js only).

**The script is bundled with this skill — do NOT check if it exists. Just run it.**

**Path resolution:** This skill's directory is listed in "Additional working directories"
in the system environment. Use that path to locate the script. For example, if the
additional working directory is `/Users/x/project/.claude/skills/sealos-db/scripts`,
then run: `node /Users/x/project/.claude/skills/sealos-db/scripts/sealos-db.mjs <command>`.

**Config auto-load priority:**
1. `KUBECONFIG_PATH` + `API_URL` env vars (backwards compatible)
2. `~/.config/sealos-db/config.json` (saved by `init`)
3. Error with hint to run `init`

```bash
# Use the absolute path from "Additional working directories" — examples below use SCRIPT as placeholder
SCRIPT="/path/from/additional-working-dirs/sealos-db.mjs"

# First-time setup (parses kubeconfig, saves config, returns versions + databases)
node $SCRIPT init ~/sealos-kc.yaml

# After init, no env vars needed — config is auto-loaded
node $SCRIPT list-versions
node $SCRIPT list
node $SCRIPT get my-db
node $SCRIPT create '{"name":"my-db","type":"postgresql","quota":{"cpu":1,"memory":1,"storage":3,"replicas":1}}'
node $SCRIPT create-wait '{"name":"my-db","type":"postgresql","quota":{"cpu":1,"memory":1,"storage":3,"replicas":1}}'
node $SCRIPT update my-db '{"quota":{"cpu":2}}'
node $SCRIPT delete my-db
node $SCRIPT start|pause|restart|enable-public|disable-public my-db
```

## Reference Files

- `references/api-reference.md` — API endpoints, resource constraints, error formats. Read first.
- `references/defaults.md` — Tier presets, type recommendations, config card templates, termination policy. Read for create operations.
- `references/openapi.json` — Complete OpenAPI spec. Read only for edge cases.

## Error Handling

**Treat each error independently.** Do NOT chain unrelated errors.

| Scenario | Action |
|----------|--------|
| Kubeconfig not found | Guide user to download from Sealos Console |
| Auth error (401) | Kubeconfig expired; re-download. Clear memory auth fields. |
| Name conflict (409) | Suggest alternative name |
| Invalid specs | Explain constraint, suggest valid value |
| Storage shrink | Refuse, K8s limitation |
| Creation timeout (>2 min) | Offer to keep polling or check console |
| "Unsupported version" (500) | Retry WITHOUT version field |
| "namespace not found" (500) | Cluster admin kubeconfig; need Sealos user kubeconfig |

## Rules

- NEVER ask a question as plain text — ALWAYS use `AskUserQuestion` with options
- NEVER read `~/.kube/config` or any kubeconfig without asking the user first via `AskUserQuestion`
- NEVER run `test -f` on the skill script — it is always present, just run it
- NEVER accept pasted kubeconfig — API requires exact original YAML; pasting corrupts it
- NEVER write kubeconfig to `~/.kube/config` — may overwrite user's existing config
- NEVER echo kubeconfig content to output
- NEVER delete without explicit name confirmation
- NEVER construct HTTP requests inline — always use `scripts/sealos-db.mjs`
- When writing to `.env`, append, don't overwrite
- Version must come from `node scripts/sealos-db.mjs list-versions`. If rejected, retry without version field
- MySQL type is `apecloud-mysql`, not `mysql`
- Storage can only expand, never shrink
