# Client Extension Types

Sourced from `modules/sdk/gradle-plugins-workspace/src/main/resources/com/liferay/gradle/plugins/workspace/internal/client/extension/client-extension.properties`.

Each entry in `client-extension.yaml` must have a `type` value matching one of the keys below. Classification groups them by what they extend.

## Frontend

These CETs inject UI artifacts into the browser.

| Type | Purpose | Required yaml Fields | OAuth |
| --- | --- | --- | --- |
| `customElement` | React/Vue/Web Component widget rendered in an iframe or inline | `htmlElementName`, `urls` | No |
| `globalCSS` | CSS file injected on every page | `url` | No |
| `globalJS` | JS file injected on every page | `scriptElementAttributes`, `url` | No |
| `iframe` | Portlet rendered as an iframe pointing to an external URL | `friendlyURLMapping`, `portletCategoryName`, `url` | No |
| `themeCSS` | Clay Design System variable overrides; replaces legacy theme WAR | `clayVersion`, `mainUrl` | No |
| `themeFavicon` | Custom favicon | `url` | No |
| `themeSpritemap` | Custom Clay icon SVG spritemap | `url` | No |
| `staticContent` | Static file(s) served from the portal's CDN path | `url` | No |
| `jsImportMapsEntry` | Registers an ES module in the browser's import map | `bareSpecifier`, `url` | No |
| `editorConfigContributor` | Adds toolbar buttons or config to CKEditor instances | `editorConfigKeys`, `portletNames`, `url` | No |
| `fdsCellRenderer` | Custom cell renderer for FDS (Frontend Data Set) tables | `name`, `url` | No |
| `fdsFilter` | Custom filter component for FDS tables | `name`, `url` | No |
| `commerceCheckoutStep` | Custom step injected into the Commerce checkout flow | `label`, `name`, `order`, `url` | No |

## Microservice

These CETs expose an HTTP endpoint that Liferay calls inbound. They require an `oAuthApplicationHeadlessServer` companion entry and `baseURL` pointing at the running microservice.

| Type | Purpose | Required yaml Fields | OAuth |
| --- | --- | --- | --- |
| `objectAction` | Handler called when an object action fires | `baseURL`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes — `Liferay.Headless.Object.everything` |
| `objectValidationRule` | Server-side validation for object entries | `baseURL`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes — `Liferay.Headless.Object.everything` |
| `objectEntryManager` | Full storage backend for an `ext-Service` object | `baseURL`, `objectDefinitionRestContextPath`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes — `Liferay.Headless.Object.everything` |
| `workflowAction` | Handler called at a Kaleo workflow action node | `baseURL`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes — `Liferay.Headless.Admin.Workflow.everything` |
| `notificationType` | Custom notification channel (e.g. SMS, push) | `baseURL`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes — `Liferay.Headless.Object.everything` |
| `captcha` | Custom CAPTCHA provider | `baseURL` | No |
| `commercePaymentIntegration` | Custom payment gateway | `baseURL`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes |
| `commerceShippingEngine` | Custom shipping rate calculator | `baseURL`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes |
| `commerceTaxEngine` | Custom tax calculation engine | `baseURL`, `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes |

## Configuration

These CETs register OAuth applications or portal configuration entries. No microservice or URL is required.

| Type | Purpose | Required yaml Fields | OAuth |
| --- | --- | --- | --- |
| `oAuthApplicationHeadlessServer` | Service-account OAuth app used by microservice CETs | `scopes` | N/A (is the OAuth entry) |
| `oAuthApplicationUserAgent` | User-delegated OAuth app for frontend CETs calling Headless APIs | `scopes` | N/A |
| `instanceSettings` | Typed OSGi configuration deployed as a `.config` file | `ddmFormFields`, `scope` | No |

## Batch

These CETs import bulk data or initialize a full site.

| Type | Purpose | Required yaml Fields | OAuth |
| --- | --- | --- | --- |
| `batch` | Headless Batch Engine data import (JSON files) | `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes — `Liferay.Headless.Batch.Engine.everything` |
| `siteInitializer` | Full site setup: pages, fragments, objects, roles, content | `oAuthApplicationHeadlessServerExternalReferenceCode` | Yes — multiple scopes |

## Minimal `client-extension.yaml` Examples

### Custom Element

```yaml
<workspace-id>-my-widget:
  cssURLs:
    - "css/main.css"
  htmlElementName: "my-widget"
  name: My Widget
  type: customElement
  urls:
    - "js/main.js"
```

### Object Action Microservice

```yaml
<workspace-id>-oauth:
  name: <WorkspaceId> OAuth
  scopes:
    - Liferay.Headless.Object.everything
  type: oAuthApplicationHeadlessServer

<workspace-id>-on-create:
  baseURL: "http://localhost:8081"
  name: On Create Handler
  oAuthApplicationHeadlessServerExternalReferenceCode: <workspace-id>-oauth
  type: objectAction
```

### Site Initializer

```yaml
<workspace-id>-site-init:
  name: <WorkspaceId> Site Initializer
  oAuthApplicationHeadlessServerExternalReferenceCode: <workspace-id>-site-oauth
  type: siteInitializer

<workspace-id>-site-oauth:
  name: <WorkspaceId> Site OAuth
  scopes:
    - Liferay.Headless.Admin.Site.everything
    - Liferay.Headless.Admin.Content.everything
    - Liferay.Object.Admin.REST.everything
    - Liferay.Headless.Object.everything
    - Liferay.Headless.Admin.User.everything
  type: oAuthApplicationHeadlessServer
```
