# Policy and technical status of subscriptions and keys in a third-party desktop app (Acabox PI)

**As of 2026-10-15.** Every web fetch below was done on that date. The OpenAI SIWC docs deployment was last modified 2026-10-15 17:06 UTC (Last-Modified header of https://developers.openai.com/siwc/llms-full.txt).

**Labels used throughout**
- [P] primary vendor source (docs, terms, vendor repo).
- [P-staff] a vendor employee on a vendor-owned channel.
- [S] secondary (press, blogs, user forums).
- [PI-code] read from the PI clone (HEAD 5ab7fe74c400097b386662205cd93900695b8a71, 2026-10-15; package 1.2.0).
- INFERRED means my inference.
- The product owner asked about "OpenAI/Claude/OpenRouter API keys". Where a source says only "API key", I say so.

**Working directory (scratch, read-only for everyone else):** `W=/private/tmp/claude-501/-Users-iliasbeshimov-Documents-Dev-Folders-Acabox/401d6f55-ea67-4229-886b-3fa3622f6c9f/scratchpad/work-policy`. Saved primary sources are under `$W/dl-*`. `$W/notes.md` has line-numbered quotes.
- `openai.com/policies/*`, `help.openai.com/*` and the SIWC interest form return HTTP 403 to non-browser clients. I read them from Wayback captures, with capture timestamps given below. The live pages could have changed since.
- Everything on developers.openai.com and learn.chatgpt.com was read live as `.md` twins or `llms-full.txt`.

---

## 0. Executive summary (quotable to the product owner)

1. **OpenAI "Sign in with ChatGPT" plan usage exists, is documented, and is self-serve for open-source and locally hosted apps.**
   - Registration is dynamic (`client_id=dynamic_agent_client`), with no client secret and no partner key.
   - OpenAI's own user docs list **Pi** as an open-source integration.
   - Official scope is "open-source and locally hosted apps". For "paid or remotely hosted" apps OpenAI says to use an interest form, and it says plan usage is "available to all open-source partners and **selected private clients**".
   - The `acabox-pi` GitHub repo is currently **PUBLIC with no license** (`gh repo view`: visibility PUBLIC, licenseInfo null, created 2026-10-15T16:44:54Z). Whether Acabox PI counts as open-source, a private client, or neither is a product-owner decision. Not publishing as open-source and not filing the interest form is the riskiest option.
2. **It is a preview with live problems today.**
   - OpenAI's own devkit repo has two open issues. One is a persistent HTTP 520 from `api.openai.com/v1/*` for every SIWC token since 2026-10-14 ~13:33 UTC, still reproducing 2026-10-15 14:43 UTC. The other is refresh tokens refused with `invalid_grant` (hourly re-login).
   - ChatGPT Business workspaces are denied with `3p_delegated_access_policy_denied`. Scientists on university Edu/Enterprise plans may hit the same wall (not tested; INFERRED).
3. **SIWC Terms (dated 2026-09-29) bind Acabox PI.**
   - Use the app's own name (not "Pi", and do not impersonate any other app).
   - Keep tokens local.
   - No charge to the user for using their plan.
   - Express consent before background use.
   - No "general-purpose API access for other tools".
   - OpenAI may suspend the application's SIWC access.
4. **Anthropic: API keys only.**
   - Third-party developers may not "route requests through Free, Pro, or Max plan credentials", and "may not collect, store, or intermediate Claude.ai credentials".
   - PI's built-in Anthropic OAuth **impersonates Claude Code** (client id, `claude-cli` User-Agent, injected "You are Claude Code" system prompt). Anthropic's support doc says tools that "misrepresent their identity to Anthropic's servers" are prohibited and may be enforced against. Acabox PI must not expose that login.
5. **OpenRouter: API key and OAuth PKCE are both first-class.** PKCE yields a user-controlled API key, localhost callbacks work on any port, and usage and cost come back in every response.
6. **Google: API keys only.** Google's own Gemini CLI terms call third-party use of Gemini CLI OAuth "a violation of applicable terms and policies", and suspensions were reported from mid-February 2026. PI removed Gemini CLI and Antigravity OAuth in 0.71.0 (2026-04-30).
7. **Legacy Codex route** (Codex CLI client `app_EMoamEEZ73f0CkXaXp7hrann`):
   - It is undocumented as a third-party route, tolerated and welcomed in OpenAI staff statements for open-source harnesses, and I found no enforcement or ban report.
   - It presents as Codex's first-party client, and it works for ChatGPT Business without admin approval (one user report) while the new route is denied.
   - Treat it as fragile and unsupported. Do not make it the default.

---

## 1. OpenAI: Sign in with ChatGPT (SIWC)

### 1.1 Program status and who may integrate [P, retrieved 2026-10-15]

Source: `https://developers.openai.com/siwc/llms-full.txt` (saved `$W/dl-openai-md/siwc-llms-full.txt`; line numbers below refer to it).

- **Quickstart (l.307-309):** "Sign in with ChatGPT is currently available to selected commercial partners through a limited trial. ChatGPT plan usage is available to all open-source partners and selected private clients."
- **Identity-only for websites and plugins (l.370-373, l.1002-1004):** "currently offered to a select group of commercial partners. To join the waitlist, complete the Sign in with ChatGPT interest form."
- **Open-source overview (`/siwc/token-sharing-open-source`):**
  - "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you’re interested in offering it in a paid or remotely hosted app, complete the interest form."
  - "The OAuth flow for OSS clients registers a **user-defined agent** during Sign in with ChatGPT."
- **Cookbook (`/cookbook/articles/sign-in-with-chatgpt.md`):** "At launch, ChatGPT plan usage is available to open-source projects, personal projects that run locally, and selected private apps." Also: "available for open-source tools and personal projects that run locally. If you’re building a paid or remotely hosted app, join the waitlist ... before offering it to users."
- **Interest form** (Wayback 2026-10-10, `https://openai.com/form/sign-in-with-chatgpt-interest/`):
  - Text: "We launched at DevDay with partners in developer tools and open source software. If you’re an open source developer, explore our developer docs. If you’re a commercial partner ... complete the form below."
  - Fields: work email, name, company, website URL, job title, capability (Sign in only / Sign in and ChatGPT plan use), "Which of your products would use Sign in with ChatGPT?". No SLA or criteria are published.
- **OpenAI user docs list partners** (`https://learn.chatgpt.com/docs/sign-in-with-chatgpt.md`):
  - Plan usage: Amp Code, Conductor, Dactyl, Devin, Hermes Agent, Hyperagent, Kilo Code, Lovable (coming soon), Notion, Vercel, Vorflux, Warp.
  - Sign-in only: Airtable, Canva, GitLab, HubSpot, Supabase.
  - **Open-source integrations: OpenClaw, OpenCode, Pi (github.com/earendil-works/pi), T3.**
- **Announcement:** DevDay, 2026-09-29. The OpenAI Developer Community recap (author N2U, 2026-09-29 7:11pm) says "Eligible subscription usage" through "16 launch partners" and links https://developers.openai.com/siwc and the help article. [S] reports of "more than 60 partner products" and Go-plan expansion (huggingnews, feed date 2026-10-08) are unverified.
- No allowlist is needed for the open-source route. A third-party app built on pi-ai (Tesota) registered itself with its own `agentName` (earendil-works/pi#10670). Registration is per user ("After the user names and authorizes the agent, the callback returns its issued client_id", l.709).

### 1.2 OAuth/OIDC flow contract [P]

- **OIDC discovery** (live fetch `https://auth.openai.com/.well-known/openid-configuration`, 2026-10-15):
  - issuer `https://auth.openai.com`
  - authorization_endpoint `https://auth.openai.com/api/accounts/authorize`
  - token_endpoint `https://auth.openai.com/api/accounts/oauth/token`
  - jwks_uri `https://auth.openai.com/.well-known/jwks.json`
  - revocation_endpoint `https://auth.openai.com/api/accounts/oauth/revoke`
  - userinfo_endpoint `https://auth.openai.com/api/accounts/oauth/userinfo`
  - **no registration_endpoint**, no device_authorization_endpoint, no end_session
  - scopes_supported ONLY `openid profile email offline_access` (the plan-usage scopes are not advertised)
  - grant_types `authorization_code`, `refresh_token`
  - code_challenge_methods `S256`
  - token_endpoint_auth_methods `client_secret_basic`, `client_secret_post`, `none`
  - So dynamic registration is a proprietary behavior of the authorize endpoint, not RFC 7591. There is no device-code flow for SIWC.
- **Authorize request** (`/siwc/token-sharing-open-source/sign-in`, l.732-746). Open the system browser at `https://auth.openai.com/api/accounts/authorize` with:
  - `client_id=dynamic_agent_client` (first registration) or the saved issued id (`oaiapp_...`)
  - `agent_name_hint=<app name>` (initial registration only; "Omit it from reauthorization")
  - `ext_agent_host_id` (required)
  - `response_type=code`
  - `redirect_uri`
  - `scope`
  - `resource=https://api.openai.com/v1`
  - `state`
  - `nonce`
  - `code_challenge_method=S256`
  - `code_challenge`
  - Optional on reauthorization: `id_token_hint` (skips the account selector) and `login_hint` (email).
- **Redirect (l.740):** "Use an HTTP loopback callback on 127.0.0.1 from initial registration onward, for example http://127.0.0.1:1455/auth/callback ... only the port may vary. ... `/callback` does not match `/auth/callback`. ... Do not substitute with `localhost`."
- **Scopes (l.741):** identity `openid profile email`; plan usage `offline_access resource.invoke chatgpt.tokens.use.direct`.
- **Callback (l.752-760):** `code`, `state`, `scope`, and on new registration the issued `client_id` (`oaiapp_...`). Do not save `dynamic_agent_client`.
- **Code exchange (l.764):** form POST `grant_type=authorization_code` with issued `client_id`, `code`, `code_verifier`, same `redirect_uri`, same `resource`. No secret.
- **Host id:**
  - Accepted formats: `urn:ietf:params:oauth:jwk-thumbprint:...` (recommended), `urn:uuid:<uuidv4>`, `did:key:`.
  - It must be opaque, persisted before first sign-in, one per installation; "A host ID is not an authentication credential."
  - "Restarting the tool or signing in again does not by itself create a new host."
- **Client vs host:** each issued client_id "is bound to the authenticated user and the workspace selected during registration"; one client can have many hosts.
- **Tokens:**
  - Access token 1 hour (`expires_in: 3600`); refresh token 30 days, rotating (each refresh returns a replacement with a fresh 30 days).
  - Token response fields: `access_token`, `refresh_token`, `id_token`, `token_type`, `expires_in`, `scope`, `earliest_refresh_at`.
  - Access-token claims: sub, aud=`https://api.openai.com/v1`, client_id, scope, `https://api.openai.com/auth{per_user_salt, encrypted_auth_metadata}`, iss, iat, exp, jti, nbf.
- **Refresh (l.474-476):** form POST to the token endpoint with `grant_type=refresh_token`, issued `client_id` ("not dynamic_agent_client"), `refresh_token`, `resource=https://api.openai.com/v1`; omit `scope`. "serialize refreshes for the same session so two processes do not race a rotating token."
- **Refresh errors (l.584):** `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused` mean clear tokens and re-run OAuth with the saved client id.
- **Sign-out (l.466-470):** form POST to the revocation endpoint (`token`, `token_type_hint=refresh_token`, `client_id`); empty 200 means success.
- **Consent declined (l.543-545):** if the grant lacks `chatgpt.tokens.use.direct`, "retain the sign-in but mark ChatGPT plan usage as disabled ... offer a clear choice: enable ChatGPT plan usage or configure another supported billing path, such as the user’s own API key." Re-consent uses `prompt=consent` ("`force_reconsent=true` only after OpenAI confirms deployment").
- **Disconnection (l.578):** "OpenAI does not currently notify your tool when a user disconnects the app in ChatGPT settings." The user disconnects at ChatGPT Settings > Security and login > Sign in with ChatGPT.
- **Credential storage (devkit docs/security.md):**
  - An OS-backed encryption provider is required: "There is no plaintext fallback" (Electron `safeStorage`).
  - Interprocess lock, atomic replace, 0600.
  - "Integrators must keep the provider and decrypted credentials out of renderer processes, logs, and telemetry."
  - ID-token validation (JWKS signature, iss, aud=issued client id, exp, nonce) is required by the docs (l.773).

### 1.3 Which ChatGPT plans qualify [P; the sources conflict]

- **Developer docs** (Quickstart l.296-298, table l.320, cookbook): "Eligible ChatGPT Plus and Pro users". `learn.chatgpt.com/docs/sign-in-with-chatgpt.md` says the same.
- **Help center** (`help.openai.com/en/articles/20001542`, Wayback 2026-10-14 09:28 UTC, "Updated: 7 days ago"; the page still said Plus/Pro only in an earlier cached version):
  - "If you have a Go, Plus, or Pro plan, you can also choose to use your ChatGPT plan for AI requests in participating commercial apps and sites".
  - "Anyone can sign in ... but the option to use your ChatGPT plan in participating commercial apps and sites is only available with Go, Plus, and Pro."
  - "ChatGPT Go, Plus, and Pro subscribers can choose to use their included ChatGPT usage in participating commercial apps ... **Supported open-source tools remain available to all ChatGPT users.**"
  - Troubleshooting: "Some capabilities available in ChatGPT or through the OpenAI API may not be available when you use your ChatGPT plan in another app."
- **Team/Business/Enterprise/Edu:** nothing in the plan-usage docs states eligibility.
  - The flow mentions a "workspace selected during registration", and the error `subscription_sharing_user_not_eligible` (403) means "unavailable for the selected user, workspace, or policy".
  - Identity-only sign-in "is available globally to authenticated ChatGPT users, including users in Enterprise organizations. Availability for members of an organization also depends on the organization’s admin settings" (help 20001410, Wayback 2026-09-08). Admin controls: "Enable Sign in with ChatGPT for your organization" and "Approved applications" in the Global Admin Console, External access.
  - Admin article (Wayback 2026-10-10): "If it is not listed, select Enable apps, find the application, and select Enable to add it to the list." Whether a user-defined agent can appear there is unknown.
  - **Observed [S/PI issues]:** a ChatGPT Business user (pi#10258, 2026-10-02) got "Your organization hasn't enabled access for this app" and the closed list of 12 apps. Another (pi#10953, 2026-10-14, Pi 1.2.0) got `3p_delegated_access_policy_denied`. The same account on "OpenAI Codex (legacy)" works "without any admin permission changes". On 2026-10-15 an admin could not find where to enable Pi.

### 1.4 API surface, request constraints, models [P]

- **Endpoints:** only `POST https://api.openai.com/v1/responses` and `GET https://api.openai.com/v1/models`. "do not point it at ChatGPT's backend-api endpoints" (l.612). "support for another client type or route is not permission to use it here" (l.571).
- **Required request shape (l.691-696):** `store:false`, `stream:true`; `input` is an array; explicit `{type:"message", role:"system"}` items are rejected (use `instructions` or developer messages).
- **Unsupported fields:** `background`, `conversation`, `max_output_tokens`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `temperature`, `top_logprobs`, `top_p`, `truncation`, `user`; and `previous_response_id` over HTTP.
- **Tools:** function and custom tools are supported (group in namespaces or supply as `additional_tools` input items); web search is "subject to model and account/workspace policy".
  - Unsupported: image generation, file search, Code Interpreter, native computer use, hosted MCP/connectors, Responses `tool_search`.
  - Inputs: text, images, files if the model accepts them. No audio/video input, Files upload API or transcription API.
- **A user test [S]** (IgorWarzocha/howaboua-pi-stuff#484, 2026-10-06): Responses `web_search` works. `image_generation` is rejected with "User subscription sharing currently supports only 'web_search' and developer-defined 'function' and 'custom' tools, including 'namespace' and 'programmatic_tool_calling'; tool 'image_generation' is not supported. Remove it or use an API key instead." Realtime voice and Sites return 401.
- **Models:**
  - `GET /v1/models` with the access token returns `{models:[{slug, display_name, visibility}]}`; show `visibility=="list"`. "Refresh these choices when the user switches ChatGPT accounts."
  - Docs examples use `gpt-6.1-sol`.
  - OpenAI's Codex docs (learn.chatgpt.com/docs/models.md) say that with ChatGPT sign-in Plus/Pro/Business/Enterprise/Edu use GPT-6.1 Sol and Free/Go use GPT-6 Luna in the desktop app. GPT-5.5 retired from Codex ChatGPT-sign-in on 2026-10-14 19:00 UTC.
  - devkit#6 tested `gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`, `gpt-5.6-luna`, `gpt-5.6-sol` on the SIWC route. The per-plan SIWC catalog is only knowable at runtime.
- **Errors (l.553-575):**
  - Pre-stream 401/403/503 may carry `{"detail":"..."}`.
  - `subscription_sharing_user_not_eligible` 403 (don't loop OAuth); `subscription_sharing_usage_limit_exceeded` 429 (link to chatgpt.com/settings/usage; "an app-specific limit can also apply"); `subscription_sharing_usage_unavailable` 503; `subscription_sharing_unsupported_capability` 400 (inspect `error.param`); `subscription_sharing_route_not_supported` 403; `subscription_sharing_invalid_user` 401; `chatpass_v2_scope_not_authorized` and `chatpass_v2_invalid_authorization_context` 403; `subscription_sharing_user_unavailable` 503.
  - Limit errors can arrive as `response.failed` after HTTP 200 (l.679). Success only on `response.completed`.
  - "OpenAI does not silently switch the request to another billing path."

### 1.5 Limits, caps and pricing [P]

- **Plan usage:** "eligible AI requests count toward the ChatGPT Work and Codex usage included in your plan." "Connecting an app does not add a new allowance."
- **Per-app weekly cap:** ChatGPT Settings > Usage > App limits > Manage limits. The user allows the app, sets a weekly limit from 10% to 100% of overall weekly usage (10% steps), and chooses whether the app may use credits after plan limits. "An app’s limit is a cap, not a separate allowance or a reserved portion of your plan."
- **Plus** users share one five-hour limit across all apps ("no app receives a separate allowance"). "The five-hour usage limit does not apply for Pro users."
- **Credits:** opt-in, off by default, and the app limit must be 100% to use them. Automatic credit purchases can cause charges.
- **Plan size** (learn.chatgpt.com/docs/pricing.md):
  - Free $0, Go $8, Plus $20, Pro from $100 ($100/$200/$500), Business $20/user/month annual, Enterprise and Edu by contract.
  - Local messages per five hours, Plus and Standard Business: GPT-6.1 Sol 15-160; GPT-6 Astra 5-45; GPT-6 Sol 15-150; GPT-6 Luna 350-3,000.
  - Enterprise/Edu with flexible pricing have no fixed limits (credits); without flexible pricing they have Plus-like per-seat limits.
- **Quota visibility:** a remaining-quota API for SIWC tokens "is not supported at the moment. We may build this in the future" (OpenAI staff vignesh-oai, openai/sign-in-with-chatgpt-devkit#3, 2026-10-01). Only link to https://chatgpt.com/settings/usage.
- **API-key billing** is separate: API key usage is billed through the user's OpenAI Platform account at standard API rates (learn.chatgpt.com/docs/auth.md). SIWC "does not grant extra usage or access to other OpenAI services".

### 1.6 Terms, branding and consent [P]

**Sign in with ChatGPT Terms** (https://openai.com/policies/sign-in-with-chatgpt-terms/, page dated "September 29, 2026"; read via Wayback 20261007132710, saved `$W/dl-openai-terms/siwc-terms.txt`). "By integrating or using SIWC in your application, you agree to these Terms."

- §1: "Use your app's own name during sign-in and activation. Do not impersonate OpenAI, another application, or another open-source project." / "Do not ask users for their ChatGPT passwords or session cookies." / "Any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment."
- §2:
  - "User control. Requests must originate from the user's local runtime or a remote runtime only that user controls."
  - "User authorization ... Obtain express consent before background use. Another user's activity must not trigger requests to the authenticated user's account."
  - "Connected application only. Use the user's plan only for the application they connected. Do not provide general-purpose API access for other tools or unrelated requests."
  - "No charge. Users must be able to use their ChatGPT plan through SIWC without paying you or upgrading to a paid version of your application."
  - "SIWC does not grant extra usage or access to other OpenAI services."
- §3: reasonable security; a privacy notice shown before processing; promptly report vulnerabilities.
- §4:
  - Prohibited: "Creating multiple accounts, splitting usage, rotating accounts, or otherwise bypassing usage limits"; "Pooling, transferring, reselling, gifting, or sharing ChatGPT plan usage or Authentication Tokens"; "Using one user's subscription to fulfill another user's requests".
  - Compliance with "the applicable license" (linked to the devkit LICENSE) and Usage Policies.
  - "Alter, reverse engineer, or otherwise amend the SIWC software"; "Sublicense SIWC".
- §5: "Use OpenAI names, logos, and buttons only as authorized. Do not imply OpenAI sponsorship or endorsement without OpenAI's prior written permission."
- §6: "We may suspend or disable your application's access to SIWC if it violates these Terms or presents a security, safety, or abuse risk."

**UI/UX guidelines** (l.900-996):
- Label the button **Continue with ChatGPT** (or "Sign in with ChatGPT"), with approved OpenAI assets.
- Show a one-time "You're using your ChatGPT plan" modal with "Got it".
- Show "Using ChatGPT plan" near the composer or model selector with a "Manage usage" link to https://chatgpt.com/settings/usage.
- On a limit error, make "Manage usage" the primary action.
- Distinguish ChatGPT plan usage from your own app's charges.
- Support multiple accounts with a clear active-account label.
- "Your app must clearly show which of its plans support ChatGPT plan usage" (for apps with their own plans).

**DevKit license** (openai/sign-in-with-chatgpt-devkit/LICENSE, "NONCOMMERCIAL LICENSE Version 1.0"):
- "Noncommercial Purpose" excludes "development, testing, distribution, or operation of a product or service by or for a business, employer, or client in connection with its operations or commercial advantage, whether or not a fee is currently charged."
- "Commercial use of OpenAI’s Contribution requires a separate written agreement with OpenAI."
- The README says the kit is "for developers building open-source apps that run on a user's own machine". It covers the devkit code, not the OAuth protocol. PI re-implements the documented flow under MIT and does not use the devkit.

**OpenAI consumer Terms of Use** (Wayback 2026-10-12, "Effective: January 1, 2026"): "You may not share your account credentials or make your account available to anyone else"; "Automatically or programmatically extract data or Output"; "circumvent any rate limits or restrictions". SIWC is the sanctioned path around these for plan usage.

### 1.7 Reliability and known issues [P-staff / S]

- **devkit#6, OPEN (2026-10-14; last comment 2026-10-15 14:43Z):** every authenticated `POST /v1/responses` and `GET /v1/models` with a SIWC token returns HTTP 520 (Cloudflare) since ~2026-10-14 13:33 UTC, model-, client- and token-independent. A self-signed JWT whose `scope` contains `chatgpt.tokens.use.direct` gets the same 520, and one without gets a clean 401 `invalid_jwt`. `status.openai.com` shows all-operational.
- **devkit#5, OPEN (2026-10-04; last activity 2026-10-10):** the documented refresh request is refused `400 invalid_grant` / `refresh_token_invalidated` for the devkit, Codegraff, T3 Code and Pi, so "A connection therefore lasts exactly one access-token lifetime (one hour)". No OpenAI reply as of fetch. Related PI reports: pi#10377 (one user fixed it by "logging out of all sessions via the OpenAI website"), pi#10258 (Advanced Account Security accounts).
- **pi#10184 (2026-09-29):** the consent page said "This app is unavailable ... error_code: invalid_client" for Pi on launch day. Maintainer davidbrai at 20:17Z: "should work now".
- **pi#10480 (2026-10-05/06):** `subscription_sharing_usage_limit_exceeded` after a banked reset. OpenAI staff vignesh-oai replied in the PI tracker: "We fixed this issue only yesterday. All new banked reset redeems transfer over to your usage of Pi as well now in addition to Codex."
- **pi#10693 (2026-10-08, auto-closed, single reporter):** turns longer than ~15 min (895-915 s) on `openai` end with "stream ended before a terminal response event". Unverified.
- **pi#10670 (2026-10-08):** each Pi login registers a **new** client, so the user's ChatGPT "Sign in with ChatGPT" settings fill with duplicate entries. Maintainer: "we are hoping that in the future openai's oauth would be able to identify it's the same login but the device id."
- **Port conflicts (pi#10265):** concurrent logins collide on port 1455 (also used by the Codex CLI).
- **No ban, suspension or app-level block reports** were found anywhere. See section 6.

### 1.8 PI's SIWC implementation versus the docs [PI-code, `packages/ai/src/auth/oauth/openai-chatgpt.ts`]

- l.16-27: `DYNAMIC_CLIENT_ID="dynamic_agent_client"`, `AGENT_NAME_HINT="Pi"`, authorize and token URLs, `RESOURCE`, loopback `127.0.0.1:1455/auth/callback`, `SCOPE="openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"`. This matches the docs.
- l.250-263: **`agent_name_hint: options?.agentName ?? AGENT_NAME_HINT`**; `ext_agent_host_id=urn:uuid:<deviceId>` from `LoginOptions.getDeviceId()` (must be a UUID or login throws, l.226-231). `LoginOptions.agentName` is documented at `packages/ai/src/auth/types.ts:20-24` ("Name this app introduces itself with during login ... Defaults to pi's own name."). Without `agentName: "Acabox PI"` the app would present itself as "Pi", which breaches Terms §1.
- **Every login sends `dynamic_agent_client`** (l.252) and never reuses the issued client id. It stores `clientId` only for refresh (l.208-223, which sends `grant_type`, `client_id`, `refresh_token`, `resource`).
- **Skips ID-token validation** (l.200-204): it only checks the `id_token` string exists, and does not verify the signature, issuer, audience or nonce as the docs require. It does not persist the ID token (pi#10300, OPEN), so `id_token_hint` is never sent.
- **No revocation on logout.** `docs/providers.md` says /logout "does not ... revoke the credential at the provider".
- It throws if the grant lacks `chatgpt.tokens.use.direct` (l.170-172) instead of "retain sign-in, mark plan usage disabled".
- Fixed port 1455 (l.23-25, 126), with a clear EADDRINUSE error (ai CHANGELOG:119). `PI_OAUTH_CALLBACK_HOST` can change the bind host. Manual paste of the redirect URL is the headless fallback.
- Expiry margin 3 minutes (l.29).
- `packages/ai/src/api/openai-responses.ts:42-49, 357-373`: `isChatGPTSignIn()` is true only when `provider==="openai"`, `baseUrl==="https://api.openai.com/v1"` and the key does not start with `sk-`. In that case PI omits `max_output_tokens`, `temperature`, `prompt_cache_retention/options` and `configuration_update` items, and always sends `store:false`, `stream:true`. **A local proxy base URL defeats the detection** (INFERRED).
- User-Agent: `pi (<platform> <release>; <arch>)` (`packages/ai/src/utils/pi-user-agent.ts:17-19`), overridable via `model.headers` (`openai-responses.ts:296`).
- Credential precedence: PI docs (`docs/models.md:145`) say an OAuth login on `openai` hides API-key-only models "even when OPENAI_API_KEY is set; log out of openai to use the key".
- **PI wording** (`packages/coding-agent/CHANGELOG.md`):
  - [0.99.0] 2026-09-29, l.350: "**Sign in with ChatGPT** — Use a ChatGPT subscription with the OpenAI provider through `/login openai`."
  - l.360: "Pi stores a stable `deviceId` in the global settings for this login and omits it from bug reports."
  - l.384: "Renamed the inherited OpenAI Codex provider to 'OpenAI Codex (legacy)'; Sign in with ChatGPT on the OpenAI provider supersedes it."
  - ai CHANGELOG:58 (1.1.0, 2026-10-07): "Added `LoginOptions.agentName`, which replaces pi's name in the Sign in with ChatGPT agent name hint and the Codex browser login originator".
- `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) is confirmed at `packages/coding-agent/docs/environment-variables.md:81`. `PI_OFFLINE` and `PI_TELEMETRY` exist (l.84, l.86).

### 1.9 The older route (Codex CLI client id) [PI-code + P-staff + S]

- **PI still ships it** as "OpenAI Codex (legacy)" (`packages/ai/src/auth/oauth/openai-codex.ts`):
  - `CLIENT_ID="app_EMoamEEZ73f0CkXaXp7hrann"` (l.22).
  - Authorize `https://auth.openai.com/oauth/authorize`, token `https://auth.openai.com/oauth/token`, redirect `http://localhost:1455/auth/callback` (l.24-26), scope `openid profile email offline_access` (l.34).
  - Authorize extras `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=<LoginOptions.agentName ?? "pi">` (l.289-305). The device-code flow is also available (l.27-33).
  - Requests go to the ChatGPT backend with `originator: "pi"` and a Pi User-Agent (`packages/ai/src/api/openai-codex-responses.ts:1648`).
  - It needs the JWT claim `chatgpt_account_id`.
- **Status: neither documented nor prohibited.** I found no OpenAI policy text addressing third-party reuse of the Codex client id.
  - Tolerance evidence [P-staff]: @thsottiaux ("Tibo, Codex & ChatGPT @OpenAI"), 2026-01-09 21:40 UTC: "We are working with OpenCode to allow Codex users to use their Codex subscriptions and usage limits in OpenCode directly. Also exploring how to support other awesome actors in the space." (https://x.com/thsottiaux/status/2009742187484065881). His quoted post of 2026-01-09 19:52 UTC: "I am proud that we build Codex in the open ... we are 100% invested in supporting a flourishing ecosystem of agentic coding tools out there. You can already build on top of https://github.com/openai/codex/tree/main/codex-rs/app-server directly, which includes ChatGPT login and same usage as you get in codex. Reach out if you are a builder!"
  - Codex maintainer etraut-openai (openai/codex Discussion #8338, still "Unanswered"): 2025-12-19 "you're welcome to fork the repo" (Apache); 2026-02-09 "I'm an engineer, not a lawyer, so I'm not qualified to answer your questions in detail", said the terms are "quite permissive" and OSS projects like OpenCode do similar. Questions from commercial desktop apps (2026-05-05, 2026-07-20, 2026-08-27) got **no maintainer reply**.
  - OpenAI Developer Community thread 1371778 (2026-01-16): "Should other 3rd parties just piggy back on this?" with no staff reply in the captured content.
  - The Codex app-server doc (learn.chatgpt.com/docs/app-server.md l.228) says that for enterprise integrations "please contact OpenAI to get it added to a known clients list".
  - OpenClaw docs [S] assert "OpenAI explicitly supports subscription OAuth usage in external tools and workflows like OpenClaw." Pi, OpenCode, OpenClaw and T3 are now also on OpenAI's SIWC open-source list.
- **Risks:**
  - It uses a first-party client id, so it has no app identity of its own.
  - There is an access-enforcement layer on the ChatGPT backend (401 `rejected_by_access_enforcement` / `no_matching_rule`, `hardened_oauth_rule_missing` per devkit#6 and howaboua#484) that could be tightened (INFERRED).
  - One Business user reports legacy sessions expiring about every 24 h (pi#10953, unverified).
  - The consumer Terms of Use clauses on programmatic extraction and circumventing restrictions could be cited against it.
  - OpenAI's own docs treat SIWC as the path for third-party tools.

---

## 2. Anthropic [P unless marked]

**Where the clause lives.** https://code.claude.com/docs/en/legal-and-compliance (the old docs.claude.com URL redirects here), section "Authentication and credential use".

**Current text** (live `.md` fetch 2026-10-15; saved `$W/dl-anthropic/https___code_claude_com_docs_en_legal_and_compliance_md.out`):
- "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
- "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
- "Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code".
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."
- Related section "Can customers offer Claude Code in their products?": "The Claude Code binary must not be modified." and "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential".
- API keys a customer configures for its own authorized users are fine "provided the resulting usage is billed to the key owner ... and is not resold or intermediated".

**The 2026-02-19 clause, verbatim as first captured** (Wayback 20260218171531 and 20260219142355, Usage policy > Authentication and credential use). The clause was ABSENT in the 2026-02-01 06:42 UTC capture and present in the 2026-02-18 17:15 UTC capture; press coverage is dated 2026-02-19/20.
- "OAuth authentication (used with Free, Pro, and Max plans) is intended exclusively for Claude Code and Claude.ai. Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service."
- "Developers building products or services that interact with Claude’s capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
- "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

**Text history** (Wayback digests):
- v1 2026-02-18 to 03-11.
- v2 by 2026-03-16 (link change).
- v3 by 2026-04-13: the "not permitted and constitutes a violation of the Consumer Terms" sentence replaced by the "intended exclusively for purchasers ... designed to support ordinary use" wording.
- v4 2026-07-17.
- v5 by 2026-08-30: added "may not collect, store, or intermediate Claude.ai credentials or session tokens" and the exceptions paragraph.
- The wording is volatile.

**Agent SDK overview** (https://code.claude.com/docs/en/agent-sdk/overview.md, 2026-10-15): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."
- Branding: allowed "Claude Agent", "Claude" (inside an Agents menu), "{YourAgentName} Powered by Claude". Not permitted: "Claude Code" or "Claude Code Agent".
- The SDK is governed by Anthropic's Commercial Terms.

**Support article "Log in to your Claude account"** (https://support.claude.com/en/articles/13189465, "Updated today" 2026-10-15). Wayback: absent on 2026-03-12, present by 2026-04-15 with "extra usage" wording, renamed "usage credits" by 2026-05-20.
- "The preferred way to access Anthropic services using third-party software, tools, or services (“third-party tools”), including open-source projects, is through API key authentication through Claude Console or a supported cloud provider. Anthropic may at its discretion allow paid subscribers who have enabled usage credits to use certain third-party tools ... but reserves the right to draw use of such third-party tools from usage credits rather than subscription limits."
- "Use of third-party tools that misrepresent their identity to Anthropic’s servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited and such use may be enforced against."
- Under "Developers": "If you’re building a product, application, or tool for others, use API key authentication through Claude Console or a supported cloud provider. Applications that misrepresent their identity ... are prohibited".

**After April 2026:**
- 2026-04-04 12:00 PT: subscriptions stopped covering third-party harnesses (OpenClaw first), moved to pay-as-you-go "extra usage" (TechCrunch 2026-04-04 9:32 PDT [S]; The Register 2026-04-06 [S]).
- 2026-05-13: @ClaudeDevs tweet (2026-05-13 17:10 UTC): "Starting June 15, paid Claude plans can claim a dedicated monthly credit for programmatic usage ... Claude Agent SDK, claude -p, Claude Code GitHub Actions, Third-party apps built on the Agent SDK."
- Official support article https://support.claude.com/en/articles/15036540 (read 2026-10-15): "Update June 15, 2026: We’ve paused the previously-announced changes ... Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription limits." / "Update October 7, 2026: Claude Max and Team plans now include monthly API credits, which cover the Claude Agent SDK, `claude -p`, the Claude API, and Claude Managed Agents. You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits."
- Monthly credits (support 17154008): Max 5x $100, Max 20x $200, Team Standard $20/seat, Premium $100/seat (pool capped at $500). **Free, Pro and Enterprise are not eligible.** They go to a linked Console org, work with the Claude API, Agent SDK, Managed Agents and Console playground, and do not roll over. Useful for Max users with an API key.
- Interpretation (INFERRED): "third-party apps ... with your subscription limits" refers to apps built on the Agent SDK in which the user signs in to the unmodified Claude Code binary. It does not authorize a different harness (PI) to use subscription OAuth.

**Consumer Terms** (https://www.anthropic.com/legal/consumer-terms, "Effective October 8, 2025"): "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise." / "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else."

**Commercial Terms** (Effective June 17, 2025): A.1 permits Customer "to power products and services Customer makes available to its own customers and end users"; D.4 forbids "resell the Services except as expressly approved by Anthropic". This matters for company-supplied Claude keys.

**PI's Anthropic OAuth is exactly what Anthropic prohibits** [PI-code]:
- `packages/ai/src/auth/oauth/anthropic.ts:14-27`: Claude Code's client id (base64 of `9d1c250a-e61b-44d9-88ed-5944d1962f5e`), authorize `https://claude.ai/oauth/authorize`, token `https://platform.claude.com/v1/oauth/token`, scopes incl. `user:sessions:claude_code`.
- `packages/ai/src/api/anthropic-messages.ts`:
  - l.95 "Stealth mode: Mimic Claude Code's tool naming exactly".
  - l.1049-1066 headers `user-agent: claude-cli/2.1.280`, `x-app: cli`.
  - l.1142 betas `claude-code-20250219`, `oauth-2025-04-20`.
  - l.1227-1232 injected system text "You are Claude Code, Anthropic's official CLI for Claude."
  - l.1014-1016: any key containing `sk-ant-oat` is treated as OAuth.
- PI's own warning (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:322`): "Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits." Maintainer badlogic (pi#3670, 2026-04-24): "anthropic does ot allow the plan quota, which is why there's this big fat warning thrown in your face."
- **Acabox PI must hide the Anthropic OAuth login and reject `sk-ant-oat...` tokens pasted as API keys (accept `sk-ant-api...` only).**

---

## 3. OpenRouter [P, https://openrouter.ai/docs/*.md, retrieved 2026-10-15]

- **API key auth:** Bearer `https://openrouter.ai/api/v1`. "We recommend setting a credit limit on every key." Keys on OpenRouter "are more powerful": per-app credit limits and OAuth flows.
- **OAuth PKCE** (`/docs/guides/overview/auth/oauth`) is "Sign in with OpenRouter" in effect:
  - Step 1: send the user to `https://openrouter.ai/auth?callback_url=<URL>&code_challenge=<>&code_challenge_method=S256`. The challenge is optional, S256 recommended. Optional: `key_label`, `workspace_id`, `required_workspace_id`, `state` (returned unchanged).
  - Step 2: `POST https://openrouter.ai/api/v1/auth/keys` with `{code, code_verifier, code_challenge_method}` returns `{key}`, "a user-controlled API key" (not an expiring token).
  - **Fit for a desktop app:** "Localhost callbacks are supported on **any port**". "Localhost apps are assigned a fixed title matching the host and port ... but will not appear in the OpenRouter marketplace or rankings" (use a public URL callback for a custom name). **Headless mode:** omit `callback_url`; the code is shown on screen; `code_challenge` is required; the code is single-use and expires in 10 minutes. Error codes 400/403/405.
- **Models:**
  - `GET /api/v1/models` (text models by default; `output_modalities`, `supported_parameters`, `sort` filters).
  - `GET /api/v1/models/user` ("filtered by user provider preferences, privacy settings, and guardrails") takes an API key.
  - PI uses it: 1.2.0 added `personalizeOpenRouterCatalog()`, and `docs/providers.md` says a key lists only the models it may use with that key's context, max output and prices from `/models/user`.
- **Usage and cost accounting:** automatic in every response (last SSE message when streaming) as `usage{prompt_tokens, completion_tokens, completion_tokens_details.reasoning_tokens, cost, cost_details.upstream_inference_cost, prompt_tokens_details.cached_tokens/cache_write_tokens, total_tokens}`. "`usage: { include: true }` ... deprecated and have no effect". `/generation` by id for later audit; `upstream_inference_cost` there is BYOK-only. `GET /api/v1/key` returns `limit`, `limit_remaining`, `limit_reset`, `usage`, `usage_daily/weekly/monthly`, `budgets`, `free_model_daily_requests` for an in-app "remaining credit" display.
- **App attribution headers:** `HTTP-Referer` (required to create an app page), `X-OpenRouter-Title` (`X-Title` legacy), `X-OpenRouter-Categories`, `X-OpenRouter-App-Visibility: hidden`. PI's defaults (`packages/coding-agent/src/core/provider-attribution.ts:44-49`, only when install telemetry is on) are `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi`, `X-OpenRouter-Categories: cli-agent`. Acabox PI should override these with its own identity.
- **BYOK:** "The cost of using custom provider keys on OpenRouter is 5% of what the same model/provider would cost normally on OpenRouter"; pay-as-you-go includes $25,000 per month of list-price inference free (`BYOK_FEE_PERCENTAGE='5'`, `BYOK_PAYG_MONTHLY_LIST_PRICE_THRESHOLD_USD='$25,000'`).
- **Per-user keys for company-supplied access:** Management API keys (`/docs/guides/overview/auth/provisioning-api-keys`) can "Automatically create unique API keys for each customer instance" with credit limits and expiries. They cannot call completions.
- **Privacy:** per-provider retention and training flags; account-level and per-request data-policy filtering; in-region routing (eu./us.openrouter.ai) only on Business/Enterprise plans.
- **PI implementation:** `packages/ai/src/auth/oauth/openrouter.ts` uses an ephemeral loopback port (host 127.0.0.1) and a random callback path `/oauth/callback/<uuid>`, with manual paste fallback. Credential type "oauth" with `access=key`, `refresh=""`, `expires=Number.MAX_SAFE_INTEGER`. The code comment says OpenRouter sends no `state`, though the docs now list an optional `state` parameter.

---

## 4. PI docs, changelog and GitHub (last month) [PI-code, gh]

- Wording and code are in section 1.8. `docs/providers.md` ("Authenticate interactively") only says to run `/login`; it has no policy or ToS note and no app-identity note beyond `LoginOptions.agentName`.
- `LoginOptions` is consumed at `packages/coding-agent/src/core/model-runtime.ts:826-838` (`ModelRuntime.login(providerId, type, interaction, options)`). PI's own CLI passes only `getDeviceId` (`interactive-mode.ts:6347`; `settings-manager.ts:1082 getOrCreateDeviceId()`).
- **Issues read** (earendil-works/pi): #10184, #10258, #10265, #10300 (OPEN), #10377, #10413, #10480 (OPEN), #10666, #10670, #10683, #10693, #10953. Plus openai/sign-in-with-chatgpt-devkit #3, #5 (OPEN), #6 (OPEN), #7 (OPEN, owner-only Sites question, unanswered).
- No PI Discussions about SIWC problems were found (GraphQL search).
- No device-id-specific, ban, or ToS issues were found. The ban search terms returned nothing in the PI tracker.

---

## 5. Google [brief]

- **Primary:** google-gemini/gemini-cli `docs/resources/tos-privacy.md` (paragraph added by commit "Docs: Update to Terms of Service & FAQ (#20488)" on 2026-02-27; file last touched 2026-04-10; fetched 2026-10-15): "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service) using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination of your account." Supported methods: Google-account login inside Gemini CLI itself, Gemini Developer API key, Vertex AI key.
- **[S]** discuss.ai.google.dev threads (2026-02-20 "[Urgent] Mass 403 ToS Bans on Gemini API/Antigravity for Open Source CLI Users (Paid Tier)"; 2026-03-09) report 403 "This service has been disabled in this account for violation of Terms of Service" after using OpenClaw/OpenCode with Antigravity or Gemini CLI OAuth. No Google staff reply appears in those threads.
- **PI:** removed built-in Gemini CLI and Antigravity (OAuth included) in 0.71.0, 2026-04-30 (`packages/ai/CHANGELOG.md:1167`). `docs/providers.md` lists `GEMINI_API_KEY` as the supported Google route.
- I did not read the Gemini API OAuth doc (it returned a 302), so whether Google offers any sanctioned third-party end-user OAuth is **unknown**.

---

## 6. Evidence of blocking or banning after 2026-09-29

- **OpenAI SIWC apps:** none found in news, GitHub-wide issue searches, the PI tracker, or the devkit tracker. The only blocks seen are technical or policy denials: `invalid_client` for Pi on launch day (fixed the same day), `3p_delegated_access_policy_denied` on Business workspaces, and the 520 outage. SIWC Terms §6 reserves the right to suspend an application's SIWC access.
- **OpenAI legacy route:** no enforcement report found (searches for the client id, "banned", "crackdown"). One unverified 24-hour logout report exists (pi#10953).
- **Anthropic:** enforced. Third-party harness subscription coverage ended on 2026-04-04 [S]. The policy text was tightened Feb to Aug 2026.
- **Google:** enforced, with mid-February 2026 suspensions reported [S].
- Several [S] sources say OpenAI "permits" third-party harness use. None cites a dated OpenAI policy beyond the staff statements above.

---

## 7. Decision matrix for the planner (INFERRED recommendations)

| Route | Status 2026-10-15 | Recommendation for Acabox PI |
|---|---|---|
| OpenAI SIWC (dynamic client) | Official preview; self-serve for OSS/local; "selected private clients" for closed; terms apply | Offer as "Sign in with ChatGPT (preview)" with own `agentName`; decide OSS licence versus interest form; build UI/UX compliance; graceful fallback to API key |
| OpenAI legacy Codex client | Undocumented, staff-tolerated, first-party identity, no enforcement seen | Do not ship by default; if kept, hide behind an advanced, "unsupported" toggle |
| OpenAI API key | Sanctioned; the docs name it as the fallback | Ship |
| Anthropic API key (Console, Bedrock, Vertex) | Sanctioned | Ship; accept `sk-ant-api` only |
| Anthropic subscription OAuth via PI | Prohibited for third parties; PI impersonates Claude Code | Disable the provider and `ANTHROPIC_OAUTH_TOKEN` |
| OpenRouter API key | Sanctioned | Ship |
| OpenRouter OAuth PKCE | Sanctioned; yields a user-controlled key | Ship as the easy onboarding for many models |
| Google OAuth (Gemini CLI/Antigravity) | Prohibited; bans reported | Do not ship; Gemini API key only |

**Concrete obligations if SIWC ships:**
- `agentName` "Acabox PI" (not "Pi"); own User-Agent via model headers.
- A persisted UUID host id per installation in userData.
- One refresher process for the rotating token: the Electron main process owns credentials; do not let several PI processes refresh the same token (docs: "serialize refreshes").
- Tokens stored with `safeStorage` (matches existing `secretStore.ts` practice), never in the renderer, logs or telemetry.
- Revoke at logout via `/api/accounts/oauth/revoke`.
- Validate the ID token, which PI does not do.
- Re-use the issued `client_id` to avoid duplicate entries.
- Required UI: "Using ChatGPT plan" indicator and "Manage usage" link; first-time modal.
- Request shape: `store:false`, `stream:true`, no hosted tools, `baseUrl` exactly `https://api.openai.com/v1`.
- Do not expose plan access to mini-apps or other local tools through the host API proxy ("Connected application only").
- Scheduled and background runs need an express-consent UX.
- Plan usage must be free to the user.

**Notes for other readers:**
- The OAuth credential type works through PI's `AuthStorage`/`ModelRuntime`. Concurrency behaviour across processes is for the SDK-surface reader.
- PI attribution headers are controlled by `enableInstallTelemetry`/`PI_TELEMETRY`.

## KEY FACTS
- OpenAI limits SIWC plan usage to open-source/local apps plus selected private clients; identity-only SIWC is for selected commercial partners (limited trial, waitlist).
  - evidence: https://developers.openai.com/siwc/llms-full.txt l.307-309 (retrieved 2026-10-15): "Sign in with ChatGPT is currently available to selected commercial partners through a limited trial. ChatGPT plan usage is available to all open-source partners and selected private clients."
- Paid or remotely hosted apps must use the interest form before offering plan usage; the OSS docs are scoped to open-source and locally hosted apps.
  - evidence: https://developers.openai.com/siwc/token-sharing-open-source: "These docs explain ChatGPT plan usage for open-source and locally hosted apps. If you’re interested in offering it in a paid or remotely hosted app, complete the interest form."
- Cookbook repeats the local/open-source scope and tells paid/remote apps to join the waitlist before offering it to users.
  - evidence: https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt.md: "available for open-source tools and personal projects that run locally. If you’re building a paid or remotely hosted app, join the waitlist ... before offering it to users."
- OpenAI's own user docs list Pi (earendil-works/pi) as an open-source integration for Sign in with ChatGPT.
  - evidence: https://learn.chatgpt.com/docs/sign-in-with-chatgpt.md (2026-10-15): "Open-source integrations: OpenClaw, OpenCode, Pi (https://github.com/earendil-works/pi), T3"
- Interest form asks company, website, products and capability (sign-in only vs plan use); no criteria or SLA published.
  - evidence: Wayback 20261010083403 of https://openai.com/form/sign-in-with-chatgpt-interest/: "If you’re a commercial partner interested in integrating Sign in with ChatGPT, complete the form below." Fields: Work email, Company name, Website URL, 'What capabilities would you like to implement?'
- Open-source flow registers a user-defined agent dynamically with no client secret or partner key.
  - evidence: siwc-llms-full.txt l.709: "Start first-time registration with client_id=dynamic_agent_client, include the host’s ext_agent_host_id, and set agent_name_hint to your app’s actual name ... This direct flow needs neither a client secret nor a partner API key."
- Authorize/redirect/scope/resource contract for plan usage.
  - evidence: siwc-llms-full.txt l.740-742: redirect "http://127.0.0.1:1455/auth/callback ... only the port may vary ... Do not substitute with localhost"; scope "openid profile email" + "offline_access resource.invoke chatgpt.tokens.use.direct"; resource "https://api.openai.com/v1"
- OIDC discovery has no registration_endpoint, advertises only openid/profile/email/offline_access, S256 only, no device-code grant, and a revocation endpoint.
  - evidence: https://auth.openai.com/.well-known/openid-configuration (2026-10-15): revocation_endpoint=https://auth.openai.com/api/accounts/oauth/revoke; grant_types_supported=['authorization_code','refresh_token']; registration_endpoint absent
- Access token lasts 1 hour; refresh token 30 days and rotates; refresh must be serialized and send the issued client_id plus resource.
  - evidence: siwc-llms-full.txt l.851-853 "Access tokens are valid for one hour (expires_in: 3600). Refresh tokens are valid for 30 days."; l.474-476 "serialize refreshes for the same session so two processes do not race a rotating token"
- Only POST /v1/responses and GET /v1/models are supported; not ChatGPT backend-api.
  - evidence: siwc-llms-full.txt l.612: "Use the public Responses API endpoint above for this ChatGPT plan usage flow; do not point it at ChatGPT's backend-api endpoints."; l.571 route_not_supported
- Responses requests must set store:false and stream:true; many fields and hosted tools are unsupported; system-role items are rejected.
  - evidence: siwc-llms-full.txt l.691-695 (preview limitations): "Set store: false and stream: true ... explicit {type: \"message\", role: \"system\"} items are rejected"; unsupported fields incl. max_output_tokens, temperature, previous_response_id; unsupported tools: image generation, file search, Code Interpreter, native computer use, hosted MCP/connectors, tool_search
- Model picker should come from GET /v1/models with the user's token (models[] with slug, display_name, visibility).
  - evidence: siwc-llms-full.txt l.599-606: "[.models[] | select(.visibility == \"list\") | {slug, display_name}]"; examples use model gpt-6.1-sol
- Plan-usage error codes (403/429/503/400/401) and that limit errors can arrive mid-stream; OpenAI never silently falls back to another billing path.
  - evidence: siwc-llms-full.txt l.565-575 and l.679, l.549: subscription_sharing_usage_limit_exceeded (429), subscription_sharing_user_not_eligible (403), subscription_sharing_unsupported_capability (400); "OpenAI does not silently switch the request to another billing path."
- Plus has a five-hour limit shared across all apps; Pro has none; each app has a user-set weekly cap (10-100%).
  - evidence: siwc-llms-full.txt l.494-498: "For ChatGPT Plus users, the five-hour usage limit is shared across all apps ... no app receives a separate allowance. The five-hour usage limit does not apply for Pro users."; weekly limit from 10% to 100%
- Plan usage counts toward ChatGPT Work and Codex usage; credits are opt-in and need the app limit at 100%; no automatic switch to another paid option.
  - evidence: Wayback 20261014092807 of https://help.openai.com/en/articles/20001542: "eligible AI requests count toward the ChatGPT Work and Codex usage included in your plan"; "An app must have its usage limit set to 100% to be able to use credits"; "it won't automatically switch to another paid option."
- Help center says Go, Plus, Pro for commercial apps and that supported open-source tools remain available to all ChatGPT users; developer docs say only Plus and Pro (conflict).
  - evidence: help 20001542 (Wayback 2026-10-14): "Supported open-source tools remain available to all ChatGPT users."; siwc-llms-full.txt l.296-298: "Eligible ChatGPT Plus and Pro users can use their ChatGPT plan for AI requests in participating apps"
- Org admins can disable SIWC or restrict it to approved applications; identity-only sign-in works for Enterprise orgs subject to admin settings.
  - evidence: Wayback 20260908141804 of https://help.openai.com/en/articles/20001410: "available globally to authenticated ChatGPT users, including users in Enterprise organizations." and "Turn on Approved applications to allow members to use Sign in with ChatGPT only with applications that your organization approves."
- ChatGPT Business workspaces are denied for Pi's new SIWC login while the legacy Codex login works without admin changes.
  - evidence: https://github.com/earendil-works/pi/issues/10953 (2026-10-14): "The regular OpenAI subscription login fails with 3p_delegated_access_policy_denied and says our organization hasn’t enabled access. ... OpenAI Codex (legacy) works ... without any admin permission changes."; 2026-10-15: "our workspace admin cannot find the option to enable it for Pi."
- OpenAI staff say a remaining-quota API for SIWC tokens is not supported.
  - evidence: https://github.com/openai/sign-in-with-chatgpt-devkit/issues/3 (vignesh-oai, 2026-10-01): "This is not supported at the moment. We may build this in the future."
- SIWC Terms require the app's own name and forbid impersonating OpenAI, another app, or another open-source project.
  - evidence: https://openai.com/policies/sign-in-with-chatgpt-terms/ (dated 2026-09-29; Wayback 20261007132710) §1: "Use your app's own name during sign-in and activation. Do not impersonate OpenAI, another application, or another open-source project."
- SIWC Terms require local token storage.
  - evidence: SIWC Terms §1: "Any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment."
- SIWC Terms: express consent before background use; connected application only; no charge to the user.
  - evidence: SIWC Terms §2: "Obtain express consent before background use."; "Use the user's plan only for the application they connected. Do not provide general-purpose API access for other tools or unrelated requests."; "Users must be able to use their ChatGPT plan through SIWC without paying you or upgrading to a paid version of your application."
- SIWC Terms prohibit pooling/reselling tokens or usage, rotating accounts, and allow OpenAI to suspend an application's SIWC access.
  - evidence: SIWC Terms §4: "Pooling, transferring, reselling, gifting, or sharing ChatGPT plan usage or Authentication Tokens"; §6: "We may suspend or disable your application's access to SIWC if it violates these Terms or presents a security, safety, or abuse risk."
- UI/UX guidelines require 'Using ChatGPT plan' near the composer with a Manage usage link, a first-use confirmation, and Manage usage as the primary action on limit errors.
  - evidence: siwc-llms-full.txt l.944-946: "display Using ChatGPT plan near the composer or model selector. Include a Manage usage link to ChatGPT usage settings"; l.909-911 "You're using your ChatGPT plan" / "Got it"; l.958 "Make Manage usage the primary action."
- OpenAI's DevKit is under a noncommercial license that excludes business products; the README targets open-source apps on the user's machine.
  - evidence: https://github.com/openai/sign-in-with-chatgpt-devkit LICENSE: "Noncommercial Purpose ... excludes development, testing, distribution, or operation of a product or service by or for a business, employer, or client in connection with its operations or commercial advantage"; "Commercial use of OpenAI’s Contribution requires a separate written agreement with OpenAI."; README: "for developers building open-source apps that run on a user's own machine"
- OpenAI requires OS-backed credential encryption with no plaintext fallback and credentials kept out of renderers/logs/telemetry.
  - evidence: devkit docs/security.md: "There is no plaintext fallback." and "Integrators must keep the provider and decrypted credentials out of renderer processes, logs, and telemetry."
- Refresh grant is refused with invalid_grant/refresh_token_invalidated for several clients including Pi (open, no OpenAI reply as of last activity 2026-10-10).
  - evidence: https://github.com/openai/sign-in-with-chatgpt-devkit/issues/5: "A connection therefore lasts exactly one access-token lifetime (one hour), and every app has to send the person back through the browser sign-in."; https://github.com/earendil-works/pi/issues/10377
- Persistent HTTP 520 on api.openai.com/v1 for SIWC tokens since 2026-10-14 ~13:33 UTC, still reproducing 2026-10-15.
  - evidence: https://github.com/openai/sign-in-with-chatgpt-devkit/issues/6: "every authenticated POST https://api.openai.com/v1/responses request we tested using a sign-in-with-ChatGPT OAuth access token returns HTTP 520"; comment 2026-10-15 01:50Z: a self-signed JWT whose scope includes chatgpt.tokens.use.direct also gets 520
- On launch day Pi's SIWC consent page failed with invalid_client; a maintainer said it was fixed hours later.
  - evidence: https://github.com/earendil-works/pi/issues/10184 (2026-09-29): "This app is unavailable ... error_code: invalid_client"; davidbrai 20:17Z: "should work now"
- OpenAI staff engage in PI's issue tracker and treat Pi usage as supported (banked resets transfer to Pi).
  - evidence: https://github.com/earendil-works/pi/issues/10480 (vignesh-oai, 2026-10-06): "We fixed this issue only yesterday. All new banked reset redeems transfer over to your usage of Pi as well now in addition to Codex."
- PI registers a new dynamic client on every login, creating duplicate entries in the user's connected apps; maintainers defer a fix pending OpenAI-side dedup by device id.
  - evidence: https://github.com/earendil-works/pi/issues/10670: "ChatGPT's 'Sign in with ChatGPT' settings now list two separate 'Tesota' entries"; davidbrai: "we are hoping that in the future openai's oauth would be able to identify it's the same login but the device id."; code packages/ai/src/auth/oauth/openai-chatgpt.ts:252
- PI defaults the agent name hint to 'Pi' unless LoginOptions.agentName is passed; host id must be a UUID from getDeviceId().
  - evidence: packages/ai/src/auth/oauth/openai-chatgpt.ts:17,253 `agent_name_hint: options?.agentName ?? AGENT_NAME_HINT`; :226-231 `Sign in with ChatGPT requires a device ID (UUID) for this installation`; packages/ai/src/auth/types.ts:20-24 'Defaults to pi's own name.'
- PI does not validate the ID token, does not revoke on logout, and uses fixed port 1455.
  - evidence: openai-chatgpt.ts:200-204 `Pi does not use the ID token to identify the user ... Keep the presence check`; packages/coding-agent/docs/providers.md: /logout "does not ... revoke the credential at the provider"; openai-chatgpt.ts:23-25
- PI strips unsupported fields only when provider=openai, baseUrl is exactly https://api.openai.com/v1 and the key lacks the sk- prefix.
  - evidence: packages/ai/src/api/openai-responses.ts:42-49 isChatGPTSignIn(); :357-373 omitUnsupportedFields (max_output_tokens, temperature, prompt_cache_retention/options) and store:false
- PI 0.99.0 (2026-09-29) added Sign in with ChatGPT under /login openai and renamed the old Codex provider 'legacy'.
  - evidence: packages/coding-agent/CHANGELOG.md:350 "**Sign in with ChatGPT** — Use a ChatGPT subscription with the OpenAI provider through `/login openai`."; :360 stable deviceId in global settings; :384 "Renamed the inherited OpenAI Codex provider to \"OpenAI Codex (legacy)\""
- PI still ships the legacy Codex route using the Codex CLI client id and an originator parameter.
  - evidence: packages/ai/src/auth/oauth/openai-codex.ts:22 CLIENT_ID="app_EMoamEEZ73f0CkXaXp7hrann"; :289-305 originator = agentName ?? "pi", id_token_add_organizations, codex_cli_simplified_flow; packages/ai/src/api/openai-codex-responses.ts:1648 originator:"pi"
- OpenAI staff publicly welcomed third-party harnesses using Codex subscriptions (Jan 2026) but no formal policy exists.
  - evidence: https://x.com/thsottiaux/status/2009742187484065881 (2026-01-09 21:40 UTC): "We are working with OpenCode to allow Codex users to use their Codex subscriptions and usage limits in OpenCode directly. Also exploring how to support other awesome actors in the space."
- Codex maintainer would not give a policy ruling on third-party use of ChatGPT sign-in; commercial-app questions went unanswered.
  - evidence: https://github.com/openai/codex/discussions/8338 (etraut-openai, 2026-02-09): "I'm an engineer, not a lawyer, so I'm not qualified to answer your questions in detail."; later posts 2026-05-05, 2026-07-20, 2026-08-27 have no maintainer reply
- Anthropic's current legal page: API keys for developers; no Claude.ai login or plan-credential routing for third parties; no collecting or intermediating Claude.ai credentials.
  - evidence: https://code.claude.com/docs/en/legal-and-compliance.md (2026-10-15): "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens"
- The Feb 2026 clause explicitly said using Free/Pro/Max OAuth tokens in any other product or tool, including the Agent SDK, violates the Consumer Terms; it was absent on 2026-02-01 and present by 2026-02-18.
  - evidence: Wayback 20260219142355 of https://code.claude.com/docs/en/legal-and-compliance: "Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product, tool, or service — including the Agent SDK — is not permitted and constitutes a violation of the Consumer Terms of Service."; Wayback 20260201064220 lacks the section
- Anthropic support doc prohibits third-party tools that misrepresent their identity or route third-party traffic against subscription limits.
  - evidence: https://support.claude.com/en/articles/13189465 (2026-10-15): "Use of third-party tools that misrepresent their identity to Anthropic’s servers, attempt to route third-party traffic against subscription limits, or otherwise violate applicable terms or policies is prohibited and such use may be enforced against."; Wayback shows the section added between 2026-03-12 and 2026-04-15
- Anthropic Agent SDK docs: no claude.ai login or rate limits for third-party products unless previously approved; use API keys.
  - evidence: https://code.claude.com/docs/en/agent-sdk/overview.md: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
- After April 2026 Anthropic paused the Agent SDK billing change (June 15) and added monthly API credits for Max/Team (Oct 7); Pro, Free and Enterprise not eligible.
  - evidence: https://support.claude.com/en/articles/15036540: "Update June 15, 2026: We’ve paused the previously-announced changes ... Update October 7, 2026: Claude Max and Team plans now include monthly API credits"; https://support.claude.com/en/articles/17154008: "Free, Pro, and Enterprise plans aren't eligible."
- Anthropic Consumer Terms forbid automated access except via an API key or explicit permission.
  - evidence: https://www.anthropic.com/legal/consumer-terms (Effective October 8, 2025): "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it, to access the Services through automated or non-human means, whether through a bot, script, or otherwise."
- PI's Anthropic OAuth impersonates Claude Code (client id, claude-cli user agent, injected 'You are Claude Code' system prompt, Claude Code tool names).
  - evidence: packages/ai/src/auth/oauth/anthropic.ts:14 CLIENT_ID base64 9d1c250a-e61b-44d9-88ed-5944d1962f5e; packages/ai/src/api/anthropic-messages.ts:95 'Stealth mode: Mimic Claude Code's tool naming exactly', :1049-1066 user-agent `claude-cli/${claudeCodeVersion}` x-app cli, :1227-1232 "You are Claude Code, Anthropic's official CLI for Claude.", :1014-1016 isOAuthToken = apiKey.includes("sk-ant-oat")
- PI warns that Anthropic subscription use in a third-party harness is billed as extra usage; PI's maintainer confirms Anthropic does not allow plan quota.
  - evidence: packages/coding-agent/src/modes/interactive/interactive-mode.ts:322 "Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits."; https://github.com/earendil-works/pi/issues/3670 (badlogic, 2026-04-24)
- Anthropic Commercial Terms allow powering your own product for your customers but forbid reselling the Services without approval.
  - evidence: https://www.anthropic.com/legal/commercial-terms (Effective June 17, 2025) A.1 "to power products and services Customer makes available to its own customers and end users"; D.4 "...or resell the Services except as expressly approved by Anthropic"
- OpenRouter OAuth PKCE returns a user-controlled API key, supports localhost on any port, and has a headless paste mode.
  - evidence: https://openrouter.ai/docs/guides/overview/auth/oauth.md: "Localhost callbacks are supported on any port"; "exchange the code for a user-controlled API key" via POST https://openrouter.ai/api/v1/auth/keys; headless: omit callback_url, code_challenge required, code expires after 10 minutes
- OpenRouter returns usage and cost in every response; GET /api/v1/key exposes remaining credit; /models/user filters by key preferences and guardrails.
  - evidence: https://openrouter.ai/docs/guides/guides/usage-accounting.md: "Full usage details are now always included automatically in every response." with usage.cost; llms-full.txt: `GET /api/v1/key` fields limit_remaining, usage_daily; /models/user description "filtered by user provider preferences, privacy settings, and guardrails"
- OpenRouter BYOK costs 5% of normal OpenRouter price; management keys can mint per-customer keys.
  - evidence: https://openrouter.ai/docs/guides/overview/auth/byok.md: BYOK_FEE_PERCENTAGE='5' "{BYOK_FEE_PERCENTAGE}% of what the same model/provider would cost normally on OpenRouter"; https://openrouter.ai/docs/guides/overview/auth/provisioning-api-keys.md: "Automatically create unique API keys for each customer instance"
- PI sets OpenRouter attribution headers naming Pi (HTTP-Referer https://pi.dev) when install telemetry is enabled.
  - evidence: packages/coding-agent/src/core/provider-attribution.ts:44-49 "HTTP-Referer": "https://pi.dev", "X-OpenRouter-Title": "pi", "X-OpenRouter-Categories": "cli-agent"
- Google states third-party use of Gemini CLI OAuth violates its terms and can get accounts suspended; only API-key routes are listed besides Google's own login.
  - evidence: https://github.com/google-gemini/gemini-cli docs/resources/tos-privacy.md: "using OpenClaw with Gemini CLI OAuth) is a violation of applicable terms and policies. Such actions may be grounds for suspension or termination of your account."
- PI removed Google Gemini CLI and Antigravity OAuth in 0.71.0 (2026-04-30).
  - evidence: packages/ai/CHANGELOG.md:1167 "Removed built-in Google Gemini CLI and Google Antigravity support, including provider registration, model metadata, OAuth, and package exports."
- PI relocates its agent dir via PI_CODING_AGENT_DIR (confirmed).
  - evidence: packages/coding-agent/docs/environment-variables.md:81 "`PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent`"
- The acabox-pi repo is public with no licence as of 2026-10-15.
  - evidence: `gh repo view iliasacademia/acabox-pi --json visibility,licenseInfo,createdAt` -> visibility PUBLIC, licenseInfo null, createdAt 2026-10-15T16:44:54Z

## RISKS
- OpenAI eligibility classification: Acabox PI is by a company (academia.edu), and the acabox-pi repo is public but unlicensed. OpenAI scopes plan usage to open-source/local apps and 'selected private clients' (paid or remote apps go through the interest form). If Acabox PI is judged closed or commercial, SIWC access could be refused; Terms section 6 lets OpenAI suspend the application's SIWC access (the mechanism that identifies an 'application' is unknown).
- Reliability today: devkit#6 (HTTP 520 on every SIWC token since 2026-10-14 ~13:33 UTC, still failing 2026-10-15) and devkit#5 (documented refresh refused with invalid_grant, so hourly re-login) are both open in OpenAI's own repo. Without a clean fallback to an API key or OpenRouter, a SIWC-only UX will visibly break.
- Institutional users (ChatGPT Business, and likely Enterprise/Edu used by university scientists) may be blocked by org policy: 3p_delegated_access_policy_denied and 'Your organization hasn't enabled access for this app', with no discoverable admin switch for user-defined agents. INFERRED for Edu: not tested.
- Identity compliance: PI's defaults identify as 'Pi' (agent_name_hint, User-Agent 'pi (...)', OpenRouter attribution 'pi' / https://pi.dev). Shipping without overriding LoginOptions.agentName, model headers and attribution headers breaches SIWC Terms section 1 ('Do not impersonate ... another open-source project').
- Anthropic: exposing PI's Anthropic OAuth login, or accepting sk-ant-oat tokens pasted as API keys, would impersonate Claude Code (client id, claude-cli UA, injected 'You are Claude Code' prompt, Claude Code tool names). Anthropic documents such tools as prohibited and enforceable without notice. Anthropic's clause text changed at least 4 times between Feb and Aug 2026.
- Rotating refresh tokens plus multiple agent processes: OpenAI says to serialize refreshes; Acabox spawns separate agent processes per chat. Concurrent refresh can invalidate the session (refresh_token_reused/invalidated). The Electron main process should be the single refresher (INFERRED).
- Background and scheduled runs (Acabox scheduler) need express user consent under Terms section 2; mini-app or local-tool access through the host API proxy may violate 'Connected application only ... Do not provide general-purpose API access for other tools'. A local proxy base URL also defeats PI's isChatGPTSignIn detection (exact baseUrl required), so unsupported fields would be sent and return 400 subscription_sharing_unsupported_capability (INFERRED).
- Preview limits break features: no image generation, file search, Code Interpreter, hosted MCP/connectors or tool_search; store:false and stream:true mandatory; no previous_response_id; usage-limit errors can arrive as response.failed after HTTP 200; remaining quota cannot be read (OpenAI staff: not supported); a user reports streams cut at ~15 min on long xhigh turns (pi#10693, single reporter, unverified).
- Duplicate registrations: PI sends dynamic_agent_client on every login, so each re-login adds another entry to the user's ChatGPT 'Sign in with ChatGPT' list (pi#10670). OpenAI docs say to reuse the issued client_id. PI also skips ID-token validation and logout revocation, which the docs require or recommend.
- The DevKit code is under a noncommercial licence (excludes products by or for a business); Terms section 4 references 'the applicable license'. Do not copy devkit code into a commercial product without an OpenAI agreement. Ambiguity remains whether a commercial entity can rely on the self-serve OSS flow even when not using the devkit.
- Data handling for research confidentiality: SIWC requests are store:false, but retention and training treatment for consumer-plan traffic is not documented in what I read. OpenRouter routes to many providers with different retention and training policies, so data-policy filters must be set for sensitive data. Acabox's existing rule that credentials never reach the agent conflicts with PI reading tokens from its agent dir unless the main process injects them (INFERRED).
- Legacy Codex route: no formal policy and no enforcement seen, but it presents as OpenAI's first-party client id, OpenAI has an access-enforcement layer it can tighten, and one user reports 24 h logouts. It could be cut off with no notice.
- Company-supplied keys: Anthropic Commercial Terms permit powering your own product for your customers but forbid reselling the Services without approval (D.4); OpenAI's API terms were not retrievable (403). Per-user OpenRouter keys (management API) are the cleanest way to supply credit with limits; shipping one shared key inside a desktop app would leak it.
- Port 1455 is fixed in PI's SIWC and legacy flows and is shared with the Codex CLI and other concurrent PI logins; two Acabox windows or a running Codex login can fail with a port-in-use error.
- Google: re-adding any Gemini CLI/Antigravity OAuth path risks user account suspensions (reported since mid-February 2026); stay on API keys.
- Documentation drift: OpenAI's help article changed from Plus/Pro only to Go/Plus/Pro between 2026-09-29 and 2026-10-14; the help center, learn.chatgpt.com and the developer docs disagree on Free/Go. Treat every eligibility statement as time-boxed and re-verify before release.

## UNKNOWNS
- Whether OpenAI considers Acabox PI eligible for the self-serve open-source route (public but unlicensed repo, published by a company, possibly free, closed in the old Acabox) or whether it must be a 'selected private client' via the interest form. No explicit rule, criteria or response time was found.
- Whether Free plan users can use plan usage through open-source tools (help center: 'Supported open-source tools remain available to all ChatGPT users') versus Plus/Pro only (developer docs); whether Go works for open-source tools. I could not test a live sign-in.
- Whether Business, Team, Enterprise or Edu members can use SIWC plan usage with a user-defined agent, and how a global admin would approve one (External access > Enable apps is documented, but two Business users report no way to enable Pi). Edu is not mentioned in any SIWC-specific source.
- Root cause and fix timeline for the refresh_token_invalidated / invalid_grant failure (devkit#5, open, no OpenAI reply as of 2026-10-10) and for the HTTP 520 outage (devkit#6, open on 2026-10-15). Whether either is already fixed after my fetch time.
- Whether the ~15 minute stream cutoff (pi#10693) is real or intentional; only one reporter, auto-closed.
- Retention, training and zero-data-retention treatment of SIWC requests per plan and per workspace; not found in the SIWC docs or help articles read.
- How OpenAI identifies 'your application' for suspension (client_id, agent_name_hint, host id, or developer) and whether OpenAI will dedupe registrations by ext_agent_host_id as the PI maintainer hopes.
- Whether Terms section 4's reference to 'the applicable license' (the noncommercial devkit LICENSE) is meant to constrain commercial apps that implement the protocol themselves without the devkit.
- Long-term status of the legacy Codex client id route: no policy statement exists; whether the reported 24 h logouts (pi#10953) are enforcement or ordinary behaviour is unknown.
- OpenAI Services Agreement / Usage Policies / API Business Terms clauses on distributing an app that stores users' API keys or on company-supplied keys: openai.com/policies pages returned 403 and only the consumer Terms of Use (Wayback 2026-10-12), the SIWC Terms (Wayback 2026-10-07) and the sign-in help article were readable.
- Whether Anthropic treats Claude reached through OpenRouter or company-supplied keys as acceptable beyond the Commercial Terms clauses quoted; no Anthropic statement on OpenRouter was found.
- OpenRouter Terms of Service and any branding rules for an app offering OpenRouter sign-in; per-account rate limits beyond the free-model daily request cap were not read in full.
- Whether Google offers any sanctioned end-user OAuth for third-party apps for the Gemini API (the ai.google.dev OAuth doc returned a redirect and was not read); the Gemini CLI terms only say third-party use of Gemini CLI OAuth is a violation.
- Which models each ChatGPT plan actually receives on the SIWC route: only GET /v1/models at runtime answers this. Whether GPT-5.5's 2026-10-14 retirement for Codex ChatGPT sign-in also removed it from the SIWC catalog is unverified.
- Whether PI will adopt issued-client-id reuse, ID-token persistence (pi#10300 open) and logout revocation; PI maintainers deferred pi#10670 as 'quite a big change'.
- Wayback-sourced pages (help.openai.com 20001542 and 20001410, SIWC Terms, interest form, admin console article, OpenAI Terms of Use, Anthropic legal page history) reflect captures from 2026-09-08 to 2026-10-14; the live pages were not directly readable and may have changed.