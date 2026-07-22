# Codex Agent Identity · Login to Codex Without Phone Number

[中文](./README.md) | **English**

**Login to Codex without phone · No SMS verification · Skip OAuth phone verification · No verification code for Codex CLI / Cockpit**

Browser-only tool that turns an existing ChatGPT **Session / accessToken** into a Codex **`auth.json` (`agent_identity`)**, then imports it into **Cockpit** and starts an API service / Codex.

Use this when you already have a valid ChatGPT login in the browser, but do not want to go through Codex **OAuth phone / SMS / verification-code** again.

> Scope: this avoids **Codex client OAuth SMS / phone verification**. It is **not** “register a new ChatGPT account without SMS”. You must already have a valid ChatGPT session.

- **No phone / no SMS for Codex login**: register an Agent Identity from your current ChatGPT session
- **Pure frontend · no backend**: keys generated with Web Crypto; session never sent to a third-party server
- **OpenAI only**: requests go only to `auth.openai.com` for agent registration
- **Cockpit API service**: download `auth.json` → import into API service → press Start
- **Static hosting**: GitHub Pages / any CDN

**Search keywords:** `Codex Agent Identity` · `login to Codex without phone number` · `Codex no SMS verification` · `Codex without verification code` · `skip phone verification for Codex` · `ChatGPT session to auth.json` · `agent_identity` · `Cockpit import Codex` · `Codex CLI login` · `no-SMS Codex login`

> Flow aligned with the community script “久雾 · codex_agent.py”: Session → Ed25519 → `agent/register` → `auth.json`.

## Try it online

- **Primary site**: https://codex.lucoo.net/
- **GitHub Pages mirror**: https://jeremypy.github.io/codex-agent-identity/
- **Repository**: https://github.com/JeremyPy/codex-agent-identity

Local preview:

```bash
cd codex-agent-identity
python3 -m http.server 8787
# open http://127.0.0.1:8787
```

## Steps (same as the web UI)

1. **Sign in** — open [chatgpt.com](https://chatgpt.com) and log in  
2. **Copy Session** — open `https://chatgpt.com/api/auth/session` and copy the full JSON  
3. **Generate** — paste into the page (auto-format) → **Generate auth.json** → **Download**  
4. **Import into Cockpit API service**  
   1. [Download Cockpit](https://github.com/jlcodes99/cockpit-tools/releases)  
   2. Add Codex account → **Import** → **Import from local file** (`auth.json`)  
   3. Click the green **“Import directly and add to API service”**  
   4. On the **API Service** card, press **Start** (play button)  

## Input formats

| Format | Example |
|--------|---------|
| Raw JWT | `eyJhbGciOi...` |
| Session JSON | Full `/api/auth/session` response |
| Object with `accessToken` | `{"accessToken":"eyJ..."}` |
| Messy paste | UI chrome mixed in — **auto-cleaned and formatted on paste** |

## Output format

```json
{
  "auth_mode": "agent_identity",
  "agent_identity": {
    "agent_runtime_id": "agent-...",
    "agent_private_key": "MC4CAQAw...",
    "account_id": "...",
    "chatgpt_user_id": "user-...",
    "email": "...",
    "plan_type": "pro",
    "chatgpt_account_is_fedramp": false
  }
}
```

Also usable with gateways that support **Agent Identity** import (e.g. Sub2API), if your deployment supports it.

## How it works

```
Valid accessToken (JWT)
  → decode claims (account / user / plan)
  → generate Ed25519 keypair in the browser
  → POST https://auth.openai.com/api/accounts/v1/agent/register
  → receive agent_runtime_id
  → write auth.json
  → Cockpit: import into API service → Start
```

“No SMS” means: **you skip the official Codex OAuth login flow** (which may require phone verification).  
It does **not** mean free ChatGPT signup without SMS. A valid session is required.

## Browser requirements

- Web Crypto with **Ed25519** (recent Chrome / Edge / Firefox / Safari)
- **Secure Context**: `https://` or `http://localhost`

## Security & compliance

- Treat `accessToken` like a password; this page does not send it to any domain except OpenAI
- The output contains a **private key** — keep it local; do not commit it to public repos
- Use only accounts you are authorized to use; follow [OpenAI Terms](https://openai.com/policies)
- APIs and policies can change; this project is provided as-is with no long-term guarantee

## Deploy on GitHub Pages

This repo already uses Pages (`main` branch, root). Self-host:

1. Fork / push this repo  
2. Settings → Pages → Deploy from branch → `main` / `/`  
3. Open `https://<user>.github.io/codex-agent-identity/`

Also works on Cloudflare Pages, Vercel, or any static CDN.

## Layout

```
codex-agent-identity/
├── index.html
├── styles.css
├── app.js
├── assets/          # Cockpit screenshots
├── LICENSE
├── README.md        # Chinese
└── README_EN.md     # English (this file)
```

## License

MIT

---

More guides: [lucoo.net](https://lucoo.net/). Blog post (Chinese): [ChatGPT / Codex no SMS login](https://lucoo.net/postsinfo/chatgpt-codex-no-sms-login/).
