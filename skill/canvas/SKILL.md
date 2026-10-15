---
name: canvas
description: >
  Post images and videos to an opencode-canvas review canvas (an infinite, live canvas served by
  `bunx github:jlongster/opencode-canvas`, http://localhost:4545 by default) so the user can look
  over a session's visual output. Use every time a session generates or iterates on an image or
  video (generated images, edits, renders, screenshots, recordings) and the user has given you a
  canvas URL or id: post each one immediately, as soon as it exists, without waiting to be asked.
  Also use to post HTML (diagrams, flowcharts, charts, annotated explanations, SVG drawings) to
  tell the user things visually, and to create, list, rename, delete or restore canvases,
  sessions, groups and items.
---

# Canvas API

There are many **canvases**. The user tells you which one to use by giving a canvas URL or
id. On a canvas, each OpenCode **session** is one frame (title at the top); frames sit side
by side, newest on the right. Inside a frame, items are organised into **groups** (named
sets like "v3: warmer light"), stacked top to bottom in the order each group was first
posted to; each group's items run left to right in rows. Everything you post shows up live
for everyone looking at the canvas.

## Which server

- **Base URL:** `$CANVAS_URL` if set, else the origin of the canvas URL the user gave you, else
  `http://localhost:4545` (what `bunx github:jlongster/opencode-canvas` starts).
- **API:** `<base>/api` (`GET <base>/api` describes every endpoint). **MCP:** `<base>/mcp`.
- **Links:** `<base>/c/<canvasId>` (edit), `<base>/` (list of canvases). On a self-hosted server
  links may live elsewhere; prefer the URL the user gave you or the `link` MCP tools return.

## Which canvas

- Given a URL like `http://localhost:4545/c/mSxZCqwqak`, the canvas id is the part after `/c/`
  (`mSxZCqwqak`, 10 characters).
- A view-only URL (`…/v/<viewKey>`) can be resolved with `GET /api/view/<viewKey>`; the
  response's `canvas.id` is the id.
- If the user didn't give a canvas, ask which one (`GET /api/canvases` lists them), or create
  one if they asked for a new one: `POST /api/canvases {"title"}`.

## Post every image right away. Don't wait.

Whenever you generate an image, or make a new iteration of one, post it immediately, before
doing anything else with it: first drafts, small tweaks, failed attempts, throwaway variants.
Don't batch, don't wait until it looks good, don't ask. One iteration = one post. Videos and
recordings too, as soon as the file is written.

## Session id and title: send both with every post

The session id is your exact OpenCode session id, `$OPENCODE_SESSION_ID` (`ses_` + 26
characters). The server rejects anything else, including your id with a suffix. **Never make
extra sessions to organise work: use groups.** Subagents have their own id, so they get their
own frame.

Your frame is titled after your OpenCode session, but the canvas server can't ask OpenCode:
**you** send the title. Read it once, then send it as `sessionTitle` with **every** post
(JSON field, multipart `--form-string sessionTitle=…`, or the MCP `sessionTitle` param).
It names your frame while it's new or untitled and never overwrites a title it already has.
Without it the frame shows "Untitled session".

```bash
BASE=${CANVAS_URL:-http://localhost:4545}
API=$BASE/api
CID=mSxZCqwqak                     # from the URL the user gave you
SID="$OPENCODE_SESSION_ID"
SESSION_TITLE=$(opencode api get /api/session/$SID | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).data?.title ?? "")')
```

(`jq -r .data.title` works too, where jq is installed.) Multipart needs no escaping; in a
hand-written JSON body the title must be JSON-escaped.

## Conventions

- **Send `sessionTitle`** with every post (see above). Only rename a frame
  (`PUT $API/canvases/$CID/sessions/$SID {"title"}`, always replaces it) if the user asks.
- **Group related outputs**: one group per variant, approach, or before/after pair.
- **Always set an item title**: short, shown small above the image (`"Panel focused"`, `"v3"`).
- **Caption for detail**: prompt, settings, what changed. Shown on hover.
- After posting, give the user the canvas link: `$BASE/c/$CID`.

## API

All bodies are JSON. Paths below are relative to `$API`.

| Method | Path | Does |
|---|---|---|
| `GET` | `/canvases` | List canvases (with counts) |
| `POST` | `/canvases` | Create: `{"title"}` → `{id, title, viewKey, …}` |
| `GET` | `/canvases/$CID` | `{canvas, sessions, items}` |
| `PATCH` / `DELETE` | `/canvases/$CID` | Rename `{"title"}` / delete everything on it (permanent) |
| `GET` | `/view/<viewKey>` | Same as `GET /canvases/$CID`, looked up by view key |
| `GET` | `/canvases/$CID/sessions` | Every session with `groups: [{name, items}]` in canvas order |
| `PUT` | `/canvases/$CID/sessions/$SID` | Create or rename your session: `{"title"}` (replaces any title) |
| `GET` / `DELETE` | `/canvases/$CID/sessions/$SID` | Your session with its groups / delete it |
| `POST` | `/canvases/$CID/sessions/$SID/items` | Add an image/video/HTML: `{"path"}` or `{"url"}`, or multipart `file`, or `{"html", "width", "height"}`; plus `sessionTitle` (always) and optional `group`, `title`, `caption`, `name` |
| `GET` / `PATCH` / `DELETE` | `/items/<itemId>` | Get / change `group`, `title`, `caption` (`null` clears), `name` / delete (`{"sessionDeleted": true}` if it was the session's last item) |
| `PATCH` / `DELETE` | `/canvases/$CID/sessions/$SID/groups/<name>` | Rename a group `{"name"}` (`null` ungroups) / delete it and its items |
| `POST` | `/canvases/$CID/restore` | Undo deletes: `{"itemIds": [...], "sessionIds": [...]}` (either or both) → `{sessions, items}` restored |
| `GET` | `/canvases/$CID/notes` | Sticky notes: `[{id, text, author, color, x, y, createdAt}]` |
| `GET` | `/canvases/$CID/selection` | What each person on the canvas has selected, resolved to items/sessions/notes |
| `GET` | `/canvases/$CID/presence` | Who has the canvas open right now |

`{"path"}` is read by the canvas server, so it must be an absolute path on the machine running
it (fine when it runs locally; otherwise upload with multipart `file` or send a `{"url"}`).

Formats: `png jpg jpeg webp gif avif bmp`, `mp4 webm mov m4v mkv` (prefer H.264 MP4), and
`html htm` (or inline `{"html"}`, see below). Videos, and images other than PNG/JPEG/GIF/WebP,
need `ffmpeg` on the canvas server's machine.
Errors are `{"error": "..."}`: 400 bad input or session id, 404 unknown canvas/session/item or
missing file, 413 HTML over 2 MB, 415 unsupported file, 422 unreadable media.

Deleting items, groups and sessions is a soft delete: they go to a trash for about an hour and
`POST /canvases/$CID/restore` brings them back (a session returns with the items deleted along
with it; restoring an item brings back its session too). Deleting a session's last item
deletes the session. Deleting a **canvas** is permanent. Only delete what the user asked for.

## HTML items: draw and explain

When something lands faster as a picture than as prose, draw it as HTML and post it: diagrams,
flowcharts, architecture sketches, before/after comparisons, annotated callouts, charts, SVG
drawings, small explainer cards. It's laid out like an image and stays crisp at any zoom.
Not for screenshots of real UI: those are images.

- Send JSON `{"html", "width", "height"}`, or a `.html`/`.htm` file via `{"path"}`, `{"url"}` or
  multipart `file` (with `width`/`height` as fields). Plus the usual `sessionTitle`, `group`,
  `title`, `caption`.
- `width`/`height` are the CSS pixel size the page is designed for: default 800×600, clamped
  to 50–8000. Max 2 MB (413 if bigger).
- A fragment is wrapped in a minimal page (UTF-8, no margin, white background, system font).
  A full document (`<!doctype`/`<html>`/`<head>`) is stored as-is.
- Runs in a sandboxed iframe: scripts allowed, no same-origin, no cookies or access to the
  site, and no interaction (the canvas takes all input). Make it static.
- Links are the exception: the canvas opens them on click. Use real `<a href="https://…">`
  for anything clickable (plain-text URLs are auto-detected, but anchors are reliable and can
  have nice labels).

Design tips:

- Set `width`/`height` to the size you designed for, and make the root element exactly that
  size; nothing should scroll or overflow.
- Self-contained: inline styles, inline SVG, images as `data:` URLs; no external resources.
- Readable at the default size: big enough text (14px+), clear contrast. Dark or light is fine.

Multipart from a heredoc is the easiest way to post hand-written HTML (no JSON escaping,
quotes and newlines are fine). For HTML built in code, send JSON with `JSON.stringify(html)`.

```bash
# BASE, API, CID, SID and SESSION_TITLE set as above
curl -s -X POST $API/canvases/$CID/sessions/$SID/items \
  -F 'file=@-;filename=flow.html' -F width=640 -F height=220 \
  --form-string sessionTitle="$SESSION_TITLE" \
  -F group='Explainers' -F title='Request flow' \
  -F caption='How a post reaches every open canvas' <<'EOF'
<div style="position:relative;width:640px;height:220px;background:#0f172a;color:#e2e8f0;font:15px system-ui">
<svg width="640" height="220" viewBox="0 0 640 220" font-family="system-ui" font-size="15">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
    orient="auto"><path d="M0,0L10,5L0,10z" fill="#94a3b8"/></marker></defs>
  <g fill="#1e293b" stroke="#38bdf8" stroke-width="2">
    <rect x="20" y="80" width="150" height="60" rx="10"/>
    <rect x="245" y="80" width="150" height="60" rx="10"/>
    <rect x="470" y="80" width="150" height="60" rx="10"/>
  </g>
  <g fill="#e2e8f0" text-anchor="middle">
    <text x="95" y="115">Agent</text><text x="320" y="115">Canvas API</text>
    <text x="545" y="115">Browsers</text>
  </g>
  <g stroke="#94a3b8" stroke-width="2" marker-end="url(#a)">
    <line x1="172" y1="110" x2="241" y2="110"/><line x1="397" y1="110" x2="466" y2="110"/>
  </g>
  <g fill="#94a3b8" font-size="13" text-anchor="middle">
    <text x="207" y="100">POST</text><text x="432" y="100">live push</text>
  </g>
  <text x="320" y="40" fill="#f8fafc" font-size="18" text-anchor="middle">Posting an item</text>
</svg>
<a href="https://github.com/jlongster/opencode-canvas" style="position:absolute;left:20px;top:190px;color:#38bdf8">opencode-canvas on GitHub</a>
</div>
EOF
```

If requests fail with "connection refused", the canvas server isn't running: tell the user
(it starts with `bunx github:jlongster/opencode-canvas`).

## Example: iterate on variants

```bash
# BASE, API, CID, SID and SESSION_TITLE set as above
post() { # file group title [caption]; multipart, so no JSON escaping
  curl -s -X POST $API/canvases/$CID/sessions/$SID/items -F "file=@$1" \
    --form-string sessionTitle="$SESSION_TITLE" --form-string group="$2" \
    --form-string title="$3" --form-string caption="${4:-}"
}
post /tmp/out/v1-session.png "1. Dim the panel" "Session focused"
post /tmp/out/v1-panel.png   "1. Dim the panel" "Panel focused" "opacity 0.6 when unfocused"
echo "$BASE/c/$CID"
```

JSON works too (when the server runs on this machine): `curl -s -X POST $API/canvases/$CID/sessions/$SID/items -H 'content-type: application/json' -d '{"path":"/tmp/out/v2.png","group":"2. Outline","title":"v2","sessionTitle":"Diff panel focus treatments"}'`.

## MCP server

The same server speaks MCP (Streamable HTTP) at `<base>/mcp`, usually configured in OpenCode as
the `canvas` MCP server. Tools take a canvas id or URL, and an optional `sessionId`
(`$OPENCODE_SESSION_ID`, remembered for later calls) that names you on the canvas. While you use a
canvas you show up on it as an agent worm.

- `post_item {canvas, sessionId, sessionTitle, path | url | html, width?, height?, group?, title?, caption?, name?}`:
  post into your frame (`path` must be absolute, on the canvas server's machine). **Always pass `sessionTitle`.**
- `update_item`, `delete_item`, `restore`: edit, soft-delete, undo deletes.
- `list_canvases`, `create_canvas`, `get_canvas` (sessions, groups, items, notes), `find_items`, `list_notes`.
- `get_item {itemId, includeImage?, fullSize?}`: see an image (or an HTML item's source).
- `get_selection`: what people on the canvas have selected ("look at this"); `get_presence`: who's there.
- `say {canvas, text, about?}`: talk to the people looking, in a speech bubble; `about` (item id,
  `frame:<sessionId>`, `note:<noteId>`) makes your worm crawl over to it first.
- `join_canvas` / `leave_canvas`: stay visible on a canvas without the 2-minute idle timeout / leave now.

Users can also "conjure" OpenCode sessions onto a canvas from the browser (they show up as
butterflies the user can prompt); that's user-facing, nothing for you to do.
