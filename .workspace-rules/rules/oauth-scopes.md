# OAuth Scopes (CET Scaffolding Reference)

This card lists the `Liferay.*` scope strings that go into the `oAuthApplicationHeadlessServer` block of a `client-extension.yaml`. Use it when scaffolding microservice CETs (`objectAction`, `objectValidationRule`, `objectEntryManager`, `notificationType`, `workflowAction`, etc.), `siteInitializer` CETs, or any other CET that needs Liferay to OAuth back into the agent.

**Not needed for:**
- Curl examples using Basic auth (`test@liferay.com:test`). Basic auth as the test user has full admin perms; scopes are not evaluated.
- MCP server calls using the default `Basic` header. Same path.
- Custom elements using `Liferay.Util.fetch` (in-browser, session-cookie based).

Each scope grants access to all operations in the module. There are no per-endpoint granular scopes in the standard Liferay OAuth implementation.

## Object Modules: Admin vs Entry

Liferay's object work spans two distinct REST modules with distinct scopes:

- `Liferay.Object.Admin.REST.everything` — **admin surface**. Object **definition** CRUD: create/update/publish definitions, fields, relationships, validations, actions. Endpoints under `/o/object-admin/v1.0/`.
- `Liferay.Headless.Object.everything` — **entry surface**. Object **entry** CRUD on published objects. Endpoints under `/o/c/<pluralLabel>/`.

A microservice CET that only reads/writes object entries (most `objectAction`, `objectValidationRule`, `objectEntryManager` cases) needs only `Liferay.Headless.Object.everything`. A site initializer that also defines new objects needs both.

## Scope Table

| Module | Scope String | Grants Access To |
| --- | --- | --- |
| headless-admin-site | `Liferay.Headless.Admin.Site.everything` | Site pages, navigation menus, display page templates, master pages |
| headless-admin-content | `Liferay.Headless.Admin.Content.everything` | Structured contents, style books, fragment collections, web content |
| headless-delivery | `Liferay.Headless.Delivery.everything` | Blog posts, documents, structured content (delivery / non-admin) |
| object-admin-rest | `Liferay.Object.Admin.REST.everything` | Object **definitions**, fields, relationships, actions, validations (admin) |
| object-rest (dynamic `/o/c/<plural>`) | `Liferay.Headless.Object.everything` | Object **entries** on published objects |
| headless-admin-list-type | `Liferay.Headless.Admin.List.Type.everything` | Picklist (list type) definitions and entries |
| headless-admin-user | `Liferay.Headless.Admin.User.everything` | Accounts, users, roles, organizations |
| headless-admin-workflow | `Liferay.Headless.Admin.Workflow.everything` | Workflow definitions, instances, tasks |
| batch-engine | `Liferay.Headless.Batch.Engine.everything` | Batch data import and export task execution |

## Scope Selection by CET Type

| CET Type | Minimum Scopes |
| --- | --- |
| `objectAction` | `Liferay.Headless.Object.everything` (add `Liferay.Object.Admin.REST.everything` if the action mutates the definition) |
| `objectValidationRule` | `Liferay.Headless.Object.everything` |
| `objectEntryManager` | `Liferay.Headless.Object.everything` |
| `notificationType` | `Liferay.Headless.Object.everything` |
| `workflowAction` | `Liferay.Headless.Admin.Workflow.everything`, `Liferay.Headless.Object.everything` |
| `batchEngineDataImportTaskExecutor` | `Liferay.Headless.Batch.Engine.everything`, `Liferay.Headless.Object.everything` |
| `siteInitializer` | `Liferay.Headless.Admin.Site.everything`, `Liferay.Headless.Admin.Content.everything`, `Liferay.Object.Admin.REST.everything`, `Liferay.Headless.Object.everything`, `Liferay.Headless.Admin.User.everything` |
| Commerce CETs | Granular per Commerce subdomain — e.g. `Liferay.Headless.Commerce.Admin.Channel.everything`, `Liferay.Headless.Commerce.Admin.Order.everything`, `Liferay.Headless.Commerce.Admin.Catalog.everything`. Verify the exact subdomain against the relevant `headless-commerce-admin-*` module's `rest-config.yaml`. |

## How Scopes Appear in `client-extension.yaml`

```yaml
<workspace-id>-oauth:
  name: <WorkspaceId> OAuth Application
  scopes:
    - Liferay.Headless.Admin.Site.everything
    - Liferay.Object.Admin.REST.everything
    - Liferay.Headless.Object.everything
  type: oAuthApplicationHeadlessServer
```

Each scope string is one list entry. Liferay validates the list on deploy; unknown scope strings cause deployment to fail with a configuration error.

## Verifying Scope Coverage

If an API call returns 403 (Forbidden), the token's scopes do not cover the endpoint:

1. Check the exact endpoint against the module table above.
2. Add the missing scope to the `oAuthApplicationHeadlessServer` entry in `client-extension.yaml`.
3. Redeploy via `deploy-and-verify`.

A 401 (Unauthorized) means the token itself is not valid — check the OAuth application registration and credentials, not the scopes.

## References

- OAuth 2 application management: Control Panel → OAuth 2 Administration
- `setup-oauth` skill: companion OAuth application generation
- CET type requirements: `rules/client-extension-types.md`
