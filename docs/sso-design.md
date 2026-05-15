# SSO Design — Microsoft Entra ID (formerly Azure AD)

**Status:** Design doc. Not yet implemented. Needs an Entra tenant admin to register the app and provide credentials.
**Owner:** Engineering (Leigh) + IT/Admin
**Target tenant:** thenextstreet.com

---

## Goal

Gate both `/submit` (field staff) and `/inbox` (central team) behind Microsoft 365 SSO so that:

1. **Zero new credentials** for any user — they use the M365 account they already have.
2. **Auto-attribution**: the submitter / reviewer name no longer needs to be typed; it comes from the authenticated identity.
3. **Role separation** via Entra group membership: `KeyAudit-FleetOps` group gets central-team access (process + finalize); everyone else (any authenticated `@thenextstreet.com` user) gets field-only access (submit + view their own hub's history).
4. **Tenant-restricted** — only thenextstreet.com accounts allowed.

---

## What needs to happen in Entra (admin work)

The TNS Azure/Entra admin needs to do these steps once, in the Entra portal at `https://entra.microsoft.com`. Estimated time: 15–20 min.

### 1. Register the app

- **Azure Portal → Entra ID → App registrations → New registration**
- **Name**: `TNS Spare Key Audit`
- **Supported account types**: *Accounts in this organizational directory only (The Next Street – Single tenant)*
- **Redirect URI**:
  - Type: **Web**
  - URI: `https://keyaudit.thenextstreet.com/auth/callback` (production)
  - Add a second redirect for local dev: `http://localhost:3000/auth/callback`

After registration, record:
- **Application (client) ID** → goes into `AZURE_CLIENT_ID` env var
- **Directory (tenant) ID** → goes into `AZURE_TENANT_ID` env var

### 2. Create a client secret (or certificate)

- **Certificates & secrets → New client secret**
- Description: `prod` (and a separate one for `dev` if desired)
- Expires: 24 months
- Copy the **value** immediately (it's only shown once) → `AZURE_CLIENT_SECRET` env var

> Production should ideally use a **certificate** rather than a secret — certificates can't leak via env-var inspection the same way. For v1 we can use a secret; design doc for certificate rotation belongs in a later iteration.

### 3. Configure API permissions

The app needs to read user profile + group membership. Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**:

- `User.Read` (already granted by default; required to identify the user)
- `GroupMember.Read.All` (so the server can check if the user is in `KeyAudit-FleetOps`)
- *(Optional)* `email`, `profile`, `openid` — usually granted automatically

After adding `GroupMember.Read.All`, **grant admin consent** for the tenant (admin button at the bottom of the permissions list).

### 4. Add ID token group claim

By default, group memberships aren't included in the ID token. Without this, the app would need a separate Graph call on every request just to check the user's role — slow and unnecessary.

- **Token configuration → Add groups claim**
- Select: **Security groups**
- For each token type, choose: **Group ID** (the `sid`/`oid` is more stable than display names)
- Save

### 5. Create the `KeyAudit-FleetOps` group

- **Entra → Groups → New group**
- Type: **Security**
- Name: `KeyAudit-FleetOps`
- Membership type: **Assigned**
- Add the current fleet ops team members (start small — 2–3 people).
- Record the **Object ID** of this group → goes into `FLEETOPS_GROUP_ID` env var.

---

## What needs to happen in code

### Library choice: `@azure/msal-node`

Microsoft's official Node library for the OAuth 2.0 / OIDC authorization-code flow. Stable, well-documented, the canonical choice for server-side Node + Entra.

```bash
npm install @azure/msal-node express-session
```

`express-session` stores the authenticated user in a server-side session keyed by a cookie. SQLite-backed session store (`better-sqlite3-session-store`) is the right fit at this volume.

### New files

```
auth.js                   New: MSAL setup, login/logout/callback handlers,
                          middleware to gate routes by authenticated +
                          (optionally) by group membership.

middleware/requireAuth.js Express middleware: redirects unauthenticated
                          users to /auth/login; attaches req.user.

middleware/requireRole.js Express middleware: 403 if user is not in the
                          required group.
```

### Routes to add

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/login` | Initiates the OAuth code flow; redirects to Microsoft |
| GET | `/auth/callback` | Receives the authorization code, exchanges it for an ID token, stores the user in the session, redirects to original target |
| POST | `/auth/logout` | Clears session, redirects to a Microsoft logout URL |
| GET | `/auth/me` | Returns the current user (JSON) — used by the frontend to show name + role |

### Routes to gate

| Path | Gate |
|---|---|
| `/submit`, `/api/submissions` (POST) | Any authenticated `@thenextstreet.com` user |
| `/inbox`, `/api/audits` (POST), `/api/submissions/:id/finalize`, `/api/submissions/:id/retry` | `KeyAudit-FleetOps` group only |
| `/api/locations`, `/api/roster`, `/uploads/*` | Any authenticated user |
| `/api/analyze` | Either remove (replaced by `/api/submissions`) or fleet-ops only |

### Environment variables

```dotenv
# Microsoft Entra ID
AZURE_TENANT_ID=<from app registration>
AZURE_CLIENT_ID=<from app registration>
AZURE_CLIENT_SECRET=<from client secret>
FLEETOPS_GROUP_ID=<object ID of KeyAudit-FleetOps group>

# Session
SESSION_SECRET=<32+ random chars; rotate periodically>
SESSION_DB_PATH=./data/sessions.db
```

### Sketch of the MSAL setup

```javascript
// auth.js
const msal = require("@azure/msal-node");

const msalConfig = {
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
};
const cca = new msal.ConfidentialClientApplication(msalConfig);

const SCOPES = ["openid", "profile", "email", "GroupMember.Read.All"];

async function login(req, res) {
  const authUrl = await cca.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: redirectUri(req),
    state: req.query.return_to || "/",
  });
  res.redirect(authUrl);
}

async function callback(req, res) {
  const token = await cca.acquireTokenByCode({
    code: req.query.code,
    scopes: SCOPES,
    redirectUri: redirectUri(req),
  });
  const claims = token.idTokenClaims;
  req.session.user = {
    oid: claims.oid,
    email: claims.preferred_username || claims.email,
    name: claims.name,
    groups: claims.groups || [],
    isFleetOps: (claims.groups || []).includes(process.env.FLEETOPS_GROUP_ID),
  };
  res.redirect(req.query.state || "/");
}
```

### Sketch of the middleware

```javascript
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect("/auth/login?return_to=" + encodeURIComponent(req.originalUrl));
}

function requireFleetOps(req, res, next) {
  if (!req.session?.user) return res.redirect("/auth/login");
  if (!req.session.user.isFleetOps) return res.status(403).send("Fleet ops access required.");
  next();
}
```

### Replacing the current manual name fields

Once SSO is live:

- `/submit` no longer asks for "Your Name" — it's pre-filled from `req.session.user.name`. The form just shows it as a confirmation: *"Submitting as Jane Doe — change account"*.
- `/inbox` similarly no longer asks the reviewer for a name in the chip-edit panel.
- `POST /api/submissions` and `POST /api/submissions/:id/finalize` no longer accept `submitter_name` / `finalized_by_name` from the body — those come from `req.session.user.name` server-side. (The DB columns stay; we just don't trust client input for these any more.)

---

## Migration path (current → SSO)

We can do this in two phases without a hard cutover:

### Phase 1 (current state)

- No auth.
- `submitter_name` and `finalized_by_name` are entered manually and trusted.
- Anyone on the LAN can submit / finalize.

### Phase 2 (SSO behind a feature flag)

- Add MSAL + middleware behind `AUTH_ENABLED=true` env var.
- When `AUTH_ENABLED` is false (current behavior), the existing manual-name path keeps working — useful for local dev where you don't want to hit Entra.
- When `AUTH_ENABLED` is true, the middleware kicks in. The manual-name fields are hidden and `req.session.user.name` is used.
- Deploy with `AUTH_ENABLED=true` to production; keep it false in `.env.example` and local dev.

### Phase 3 (cleanup)

- After a sprint of confident operation, remove the `AUTH_ENABLED` flag and the manual-name fields entirely.
- Audit the codebase for any remaining "trust the client" name fields.

---

## Decisions still needed

| # | Question | Recommendation | Decider |
|---|---|---|---|
| S1 | Single-tenant only? | **Yes** — single-tenant restricts to @thenextstreet.com automatically | Fleet Ops |
| S2 | One `KeyAudit-FleetOps` group vs. separate "viewer" / "editor" groups | **Start with one group**; split later if needed | Fleet Ops |
| S3 | Leadership / read-only group for cross-hub visibility | **Add as Phase 2**; not v1 | Fleet Ops + Leadership |
| S4 | Certificate vs. secret for client credentials | **Secret for v1**; migrate to certificate before public-facing prod | Engineering |
| S5 | Session storage: in-memory, SQLite, or Redis | **SQLite** (`better-sqlite3-session-store`) — single-process, matches our existing data store | Engineering |
| S6 | Session TTL | **8 hours** sliding window — covers a workday without forcing midday re-auth, short enough that lost laptops timeout reasonably | Fleet Ops + IT |
| S7 | What happens when a fleet-ops person is removed from the group during an active session? | **Check group membership on every fleet-ops action** (not just at login) — cached in the session but re-verified periodically (e.g., on every finalize) | Engineering |

---

## Risk / open issues

- **Group claim size limit**: if a user is in >200 groups, Entra omits the group claim and includes a `_claim_sources` reference instead. We'd need to make a Graph call to enumerate. Unlikely to hit this in a 15-hub TNS context, but the code should handle the fallback.
- **First-time login UX**: the OAuth redirect dance is jarring on mobile. Consider an interstitial "Sign in with Microsoft" page rather than auto-redirecting.
- **Cookie size**: ID tokens can be 4KB+. Make sure session cookies use server-side storage (which we're planning) rather than embedding the token in the cookie.

---

## What's NOT in this design

- **Public sign-up / external accounts** — not allowed. Tenant-restricted.
- **B2B / guest access** — not in v1.
- **Multi-tenancy** — TNS-only.
- **Service principal auth for app-to-app calls** — that's for the Planner integration (see [planner-design.md](planner-design.md)) and is a separate concern.
- **Token revocation on logout** — MSAL logout invalidates the session but the ID token remains valid until expiry. Acceptable for v1; tenant admins can force-revoke if needed.
