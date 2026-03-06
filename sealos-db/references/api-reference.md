# Sealos Database API Reference

Base URL: `https://dbprovider.{domain}/api/v2alpha`

## Authentication

All requests require a URL-encoded kubeconfig YAML in the `Authorization` header,
**except** `GET /databases/versions` which requires no authentication.

```
Authorization: <encodeURIComponent(kubeconfigYaml)>
```

## Supported Database Types

| Type | Identifier | Default Port | Typical Use |
|------|-----------|------|-------------|
| PostgreSQL | `postgresql` | 5432 | General purpose RDBMS |
| MongoDB | `mongodb` | 27017 | Document database |
| MySQL | `apecloud-mysql` | 3306 | General purpose RDBMS |
| Redis | `redis` | 6379 | Cache, sessions, pub/sub |
| Kafka | `kafka` | 9092 | Event streaming |
| Qdrant | `qdrant` | 6333 | Vector search |
| Nebula | `nebula` | 9669 | Graph database |
| Weaviate | `weaviate` | 8080 | Vector search |
| Milvus | `milvus` | 19530 | Vector search |
| Pulsar | `pulsar` | 6650 | Message queue |
| ClickHouse | `clickhouse` | 8123 | Analytics/OLAP |

**Note:** MySQL type is `apecloud-mysql`, NOT `mysql`.

## Resource Constraints

### Create (POST /databases)

| Field | Type | Range | Default |
|-------|------|-------|---------|
| cpu | number | enum: 1, 2, 3, 4, 5, 6, 7, 8 | 1 |
| memory | number | 0.1 - 32 GB (continuous range) | 1 |
| storage | number | 1 - 300 GB | 3 |
| replicas | integer | 1 - 20 | 3 |

### Update (PATCH /databases/{name})

| Field | Type | Allowed Values | Notes |
|-------|------|----------------|-------|
| cpu | number | 1, 2, 3, 4, 5, 6, 7, 8 | |
| memory | number | 1, 2, 4, 6, 8, 12, 16, 32 GB | Discrete values only |
| storage | number | 1 - 300 GB | **Expand only, cannot shrink** |
| replicas | integer | 1 - 20 | |

All update fields are optional -- only provide fields to change.

## Endpoints

### POST /databases -- Create

```json
{
  "name": "my-db",
  "type": "postgresql",
  "version": "postgresql-14.8.0",   // optional, auto-selects latest
  "quota": { "cpu": 1, "memory": 1, "storage": 3, "replicas": 1 },
  "terminationPolicy": "delete",    // optional, "delete" or "wipeout"
  "autoBackup": { ... },            // optional
  "parameterConfig": { ... }        // optional
}
```

Response: `201 Created` -> `{ "name": "my-db", "status": "creating" }`

### GET /databases -- List All

Response: `200 OK` -> Array of `{ name, uid, type, version, status, quota }`

Status values: `Running`, `Stopped`, `Creating`, `Updating`, `Failed`, `Deleting`

### GET /databases/{name} -- Get Details

Response: `200 OK` -> Full object with connection info.

Status values: `creating`, `starting`, `stopping`, `stopped`, `running`, `updating`,
`specUpdating`, `rebooting`, `upgrade`, `verticalScaling`, `volumeExpanding`, `failed`, `unknown`, `deleting`

Connection info:

```json
{
  "connection": {
    "privateConnection": {
      "endpoint": "host:port",
      "host": "my-db-postgresql.ns-xxx.svc.cluster.local",
      "port": "5432",
      "username": "postgres",
      "password": "s3cr3tpassword",
      "connectionString": "postgresql://postgres:pass@host:5432/postgres"
    },
    "publicConnection": null
  }
}
```

### GET /databases/versions -- List Available Versions

**No authentication required.** This endpoint uses the server's own service account.

Response: `200 OK` -> `{ "postgresql": ["postgresql-14.8.0", ...], ... }`

### PATCH /databases/{name} -- Update Resources

```json
{ "quota": { "cpu": 2, "memory": 4 } }
```

Response: `204 No Content`

### DELETE /databases/{name} -- Delete

Response: `204 No Content` (idempotent: returns 204 even if not found)

### POST /databases/{name}/{action} -- Actions

Actions: `start`, `pause`, `restart`, `enable-public`, `disable-public`

Response: `204 No Content` (all idempotent)

## Error Response Format

```json
{
  "error": {
    "type": "validation_error",
    "code": "INVALID_PARAMETER",
    "message": "...",
    "details": [...]
  }
}
```

Types: `validation_error`, `resource_error`, `internal_error`
