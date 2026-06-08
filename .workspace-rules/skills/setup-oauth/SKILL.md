---
name: setup-oauth
description: Create and configure the OAuth 2.0 application that a client extension needs to call Liferay Headless APIs. Use when a CET of type objectAction, workflowAction, notificationType, batchEngineDataImportTaskExecutor, siteInitializer, or any backend CET requires authenticated API access. Called by scaffold-client-extension automatically when the CET type requires OAuth.
---

# Setup OAuth

Generate the companion OAuth application entry inside `client-extension.yaml` and verify the deployed application is registered in Liferay.

## When to Invoke

- `scaffold-client-extension` identifies a CET type that requires OAuth (see `rules/client-extension-types.md`)
- A CET is deployed but returns 401 or 403 on Liferay API calls
- The user says "set up OAuth", "configure OAuth for this extension"

## Workflow

### 1. Identify the Required Scopes

Consult `rules/oauth-scopes.md` for the full scope table. Pick the minimum set that covers what the CET calls.

Examples:
- Object action that reads and writes entries: `Liferay.Headless.Admin.User.everything`, `Liferay.Headless.Object.everything`
- Site initializer that creates pages and content: `Liferay.Headless.Admin.Site.everything`, `Liferay.Headless.Admin.Content.everything`
- Batch data import only: `Liferay.Headless.Batch.Engine.everything`

### 2. Add the OAuth Application Entry to `client-extension.yaml`

Add a sibling entry of type `oAuthApplicationHeadlessServer` in the same `client-extension.yaml` as the consuming CET. The **top-level key** of this entry (its `<workspace-id>-oauth` map key — **not** its `name` field) must be referenced as the `oAuthApplicationHeadlessServerExternalReferenceCode` value in the CET entry.

```yaml
<workspace-id>-oauth:
  name: <WorkspaceId> OAuth Application
  scopes:
    - Liferay.Headless.Admin.User.everything
    - Liferay.Headless.Object.everything
  type: oAuthApplicationHeadlessServer

<workspace-id>-my-action:
  name: My Object Action
  oAuthApplicationHeadlessServerExternalReferenceCode: <workspace-id>-oauth
  type: objectAction
  # ... other fields
```

Replace `<workspace-id>` with the value of `id` in `client-extension.yaml`.

### 3. Deploy

Run `deploy-and-verify` from the client extension root. Blade copies both entries to Liferay on deploy.

### 4. Verify Registration

After deployment, confirm the OAuth application is registered:

```bash
curl -s -u "test@liferay.com:test" \
  "http://localhost:${PORT}/o/headless-admin-user/v1.0/my-user-account" \
  | jq '{id, name}'
```

Then check the OAuth application list in Control Panel → OAuth 2 Administration. The application name `<WorkspaceId> OAuth Application` should appear with status Active.

To verify the credentials are wired, check the Gogo shell:

```bash
telnet localhost 11311
lb | grep <workspace-id>
```

Both the OAuth application bundle and the CET bundle should show `ACTIVE`.

### 5. Token Acquisition (for Manual Testing)

Liferay uses the service account flow for `oAuthApplicationHeadlessServer`. The deployed CET retrieves the token automatically via the Liferay OAuth2 API. For manual testing:

```bash
curl -s -u "<clientId>:<clientSecret>" \
  -d "grant_type=client_credentials" \
  "http://localhost:${PORT}/o/oauth2/token" \
  | jq '{access_token, token_type, expires_in}'
```

The client ID and secret are displayed once in Control Panel → OAuth 2 Administration when the application is created. Retrieve them from there when needed.

### 6. Troubleshoot

| Symptom | Check |
| --- | --- |
| 401 on API call from CET | OAuth entry deployed and `ACTIVE`; token scope covers the endpoint |
| 403 on specific resource | Scope too narrow; add the resource's scope string from `rules/oauth-scopes.md` |
| Application not in Control Panel | Bundle not `ACTIVE`; run `diag <id>` in Gogo shell |
| `oAuthApplicationHeadlessServerExternalReferenceCode` not resolved | ERC in yaml must match the `<key>` (top-level key) of the OAuth entry, not the `name` field |
