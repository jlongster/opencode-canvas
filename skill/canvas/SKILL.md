---
name: canvas
description: >
  Post images and videos to an opencode-canvas review canvas (an infinite, live canvas served by
  `bunx github:jlongster/opencode-canvas`, http://localhost:4545 by default) so the user can look
  over a session's visual output. Use every time a session generates or iterates on an image or
  video (generated images, edits, renders, screenshots, recordings) and the user has given you a
  canvas URL or id: post each one immediately, as soon as it exists, without waiting to be asked.
  Also use to post HTML (diagrams, flowcharts, charts, annotated explanations, SVG drawings) to
  tell the user things visually, to post links to web pages (page, with a screenshot when you
  have one), to point the user at what to look at (say / highlight on your
  session's creature), and to create, list, rename, delete or restore canvases, sessions, groups
  and items.
---

# Canvas API

There are many **canvases**. The user tells you which one to use by giving a canvas URL or
id. On a canvas, each OpenCode **session** is one frame (title at the top); frames sit side
by side, newest on the right (people can reorder them, and hide frames: a hidden frame still
takes your posts, which don't unhide it). Inside a frame, items are organised into **groups** (named
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
Don't batch, don't wait until it looks good, don't ask. Every iteration shows up right away.
Videos and recordings too, as soon as the file is written. A new version of something already
on the canvas replaces that item in place (see "Updating an item" below) unless both versions
should be seen side by side.

## Session id and title: send both with every post

The session id is your exact OpenCode session id, `$OPENCODE_SESSION_ID` (`ses_` + 26
characters). The server rejects anything else, including your id with a suffix. **Never make
extra sessions to organise work: use groups.** Subagents have their own id, so they get their
own frame.

Your frame is titled after your OpenCode session, but the canvas server can't ask OpenCode:
**you** send the title. Read it once, then send it as `sessionTitle` with **every** post
(JSON field, multipart `--form-string sessionTitle=…`, or the MCP `sessionTitle` param).
`sessionTitle` keeps your frame named after your session; it follows renames (the frame takes
whatever title you send, so re-read it if your session may have been renamed). Without it the
frame shows "Untitled session".

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

- **Send `sessionTitle`** with every post (see above). The frame title is always the session's
  title; don't rename frames to anything else (`PUT $API/canvases/$CID/sessions/$SID {"title"}`
  exists, but the next `sessionTitle` puts the session's title back).
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
| `GET` | `/canvases/$CID/sessions` | Every session with `groups: [{name, items}]` in frame order (`"hidden": true` on frames people hid) |
| `PUT` | `/canvases/$CID/sessions/$SID` | Create or rename your session: `{"title"}` (replaces any title) |
| `GET` / `DELETE` | `/canvases/$CID/sessions/$SID` | Your session with its groups / delete it |
| `PATCH` | `/canvases/$CID/sessions/$SID` | Hide or show a frame for everyone: `{"hidden": true\|false}` (only when the user asks) |
| `GET` / `PUT` | `/canvases/$CID/order` | The frames' order `{"sessionIds"}` / rearrange them (only when the user asks) |
| `POST` | `/canvases/$CID/sessions/$SID/items` | Add an image/video/HTML: `{"path"}` or `{"url"}`, or multipart `file`, or `{"html", "width", "height"}`, or a link to a web page `{"page", "path"?}` (path/url/file: its screenshot); plus `sessionTitle` (always) and optional `group`, `title`, `caption`, `name` |
| `GET` / `PATCH` / `DELETE` | `/items/<itemId>` | Get / change `group`, `title`, `caption` (`null` clears), `name`, and/or **replace its file** (same `{"path"}`, `{"url"}`, `{"html"}` or multipart `file` as posting; see "Updating an item") / delete (`{"sessionDeleted": true}` if it was the session's last item) |
| `PATCH` / `DELETE` | `/canvases/$CID/sessions/$SID/groups/<name>` | Rename a group `{"name"}` (`null` ungroups) / delete it and its items |
| `POST` | `/canvases/$CID/restore` | Undo deletes: `{"itemIds": [...], "sessionIds": [...], "annotationIds": [...]}` (any of them; annotationIds: annotations consumed by reading them) → `{sessions, items, annotations}` restored |
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
  site. On the canvas it takes no input (the canvas takes it all), so design it to read well
  static. The user can also open it in a side drawer (full height, scrolling, fully
  interactive), where forms and scripts work and links open in new tabs.
- Links are the exception: the canvas opens them on click. Use real `<a href="https://…">`
  for anything clickable (plain-text URLs are auto-detected, but anchors are reliable and can
  have nice labels).

Design tips:

- Set `width`/`height` to the size you designed for: the canvas renders the item at exactly
  that size, so the page doesn't need to pin itself to it.
- Design it responsively. Don't hard-code `body{width:…;height:…;overflow:hidden}` (or the same
  on a full-page wrapper): in the drawer the page is shown at the drawer's width and full
  height, and scrolls. Use `max-width` containers, fluid grids (`repeat(auto-fit, minmax(…))`,
  `fr`, `%`) and let the height follow the content.
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

## Web pages: post links (with a screenshot)

To put a website, a dev server or a running deployment (a preview URL, a staging site) on the
canvas, post its URL as **`page`**, not `url` (`url` downloads a media file). **To post a link, use
`page` with the URL and include a screenshot of it (`path`/`file`) whenever you can** — take one
with your browser tooling. The canvas never fetches the URL itself, so any address works
(localhost, Tailscale, private networks). Without a screenshot it shows as a link card.

- MCP `post_item {canvas, sessionId, sessionTitle, page: "http://…", path?: "/abs/screenshot.png"}`
  (`path`, or `url`, is the screenshot, an image); over HTTP, JSON `{"page", "path"?}` or `{"page", "url"?}`
  to the items route, or multipart `page` + `file` (plus the usual `sessionTitle`, `group`,
  `title`, `caption`).
- With a screenshot the item shows it like an image, with the link's domain in a corner. Without
  one it's a link card (800×500): a globe, the `title` you give (else the URL's host), the URL and
  "Open ↗". People open the real page from either.
- The item has `kind: "page"`, `pageUrl` (the link), `screenshot` (true/false in MCP results) and,
  with one, `url` (the screenshot). Annotations on a screenshot work as on images.
- **After the site changes, send a new screenshot**: `update_item {itemId, path}` (or PATCH with
  `{"path"}`/multipart `file`). `update_item {itemId, page}` points it at another URL (keeping its
  screenshot unless you send a new one with it). Either way it keeps its id and annotations.

## Updating an item: replace it in place

To show a new version of the same visual (a fixed diagram, a re-render, a corrected screenshot,
an HTML page you revised), **replace the item in place** instead of posting a new one:
`update_item {itemId, path | url | html, width?, height?}` over MCP, or `PATCH $API/items/<itemId>`
with exactly the body you'd post: JSON `{"path"}`, `{"url"}` or `{"html", "width", "height"}`, or
multipart `file` (other fields as form fields). It can be combined with `title`, `caption`,
`group`, `name` changes.

- The item keeps its **id**, its link, its session and group, its title and caption (unless you
  change them too), and the user's **annotations** (drawn at the same relative spots, so check
  they still make sense if the layout changed a lot).
- It gets the new file's kind (an image can become a video or an HTML page), size and file name
  (unless you send `name`), and a new media `url`; everyone looking at the canvas sees the new
  version right away, including an open HTML drawer.
- It **moves to the top of its group**, like a new post. Changing only title/caption/group/name
  doesn't move it.
- HTML pages keep their `width`/`height` unless you send new ones; `width`/`height` alone resize
  an HTML item.
- Page items: a new image (`path`, `url` or `file`) replaces the screenshot; `{"page"}` points it
  at another URL (see "Web pages" above).

Post a new item instead only when both versions should be seen side by side (variants the user
will compare, a before/after pair). Keep the item id from the post's response (or find it with
`get_canvas`/`find_items`) to replace it later.

```bash
# API set as above; ITEM is the id from the post's response
# JSON: a file on the canvas server's machine (absolute path), or {"url"}
curl -s -X PATCH $API/items/$ITEM -H 'content-type: application/json' \
  -d '{"path":"/tmp/out/hero.png","caption":"v4: warmer light"}'
# multipart: upload the file (works from anywhere)
curl -s -X PATCH $API/items/$ITEM -F "file=@/tmp/out/hero.png" --form-string caption="v4: warmer light"
# HTML from a heredoc (keeps its width/height unless you send -F width=… -F height=…)
curl -s -X PATCH $API/items/$ITEM -F 'file=@-;filename=flow.html' <<'EOF'
<div style="padding:24px;font:16px system-ui">Revised diagram</div>
EOF
```

## Getting the user's attention: say and highlight

Your session has a **creature** on the canvas: a small character beside your frame (the canvas
makes one if it isn't there yet, in your session's colour, named after `sessionTitle`). When you
want the user to look at something, queue it on your creature: it calls for attention (a badge
with the count, a pulsing ring, the "N things want your attention" tray at the top) without
interrupting anyone, and the user plays your queue as a walkthrough when they're ready.

- **say**: a Markdown message from your creature.
- **highlight**: point at something (the camera glides there and your creature points at it),
  with an optional Markdown message. Targets: an item id, a group as `<sessionId>/<group name>`,
  your frame `frame:<sessionId>`, or a sticky note `note:<noteId>`. **Point at what you mean:**
  pass `point {x,y}` or `region {x,y,w,h}` in the item's image pixels (same units as annotation
  px/py and get_item's width/height); omit them only to highlight the whole item. A point gets a
  small pulsing ring, a region a rounded outline, and the camera zooms in just enough to show it.
  On a frame, group or note, `at {x,y}` (canvas page coordinates) points at a spot on the canvas;
  without it the whole thing is outlined.

Each call appends one step, in order, so tell a short story: say what you did, highlight what to
look at, say what you need. Keep steps short. It's fire-and-forget: you aren't told when they're
read, so don't wait for it; ask in your reply if you need an answer. Don't queue a step for every
post: use it when there's something worth a look or a question.

Over HTTP: `POST $API/canvases/$CID/sessions/$SID/actions` with
`{"kind": "say", "text"}` or `{"kind": "highlight", "target", "point"? | "region"? | "at"?, "text"}`,
plus `"sessionTitle"` → `{id, position, queued}`. `GET` the same path lists your queue; `DELETE` clears it.

```bash
# BASE, API, CID, SID and SESSION_TITLE set as above
act() { curl -s -X POST $API/canvases/$CID/sessions/$SID/actions -H 'content-type: application/json' \
  -d "$(bun -e 'const [k, t, x, s] = process.argv.slice(1); console.log(JSON.stringify({kind: k, target: t || undefined, text: x, sessionTitle: s}))' "$@")"; }
act say "" "Two palettes are up: **warm** and **cool**." "$SESSION_TITLE"
act highlight "$SID/2. Cool palette" "These read calmer but lose contrast. Which way?" "$SESSION_TITLE"
```

Pointing at a spot in an image (here the button at 1400,200 of a 1600×1000 screenshot, then a
300×200 panel at 100,700):

```bash
curl -s -X POST $API/canvases/$CID/sessions/$SID/actions -H 'content-type: application/json' \
  -d '{"kind":"highlight","target":"<itemId>","point":{"x":1400,"y":200},"text":"This button is clipped.","sessionTitle":"…"}'
curl -s -X POST $API/canvases/$CID/sessions/$SID/actions -H 'content-type: application/json' \
  -d '{"kind":"highlight","target":"<itemId>","region":{"x":100,"y":700,"w":300,"h":200},"text":"This panel is new.","sessionTitle":"…"}'
```

## Reading the user's annotations

**Feedback usually arrives as a prompt from the canvas**: the user presses "Submit annotations" on
your frame and you get one message starting "Feedback from the canvas on your posted items",
listing each annotated item (title, id, size), each note (or "(drawing, no text)") with the
drawing's bounding box in original-image pixels, and the marked images attached in order. Update
those items in place with `update_item` (same ids) unless a note explicitly asks for something new.
Submitted annotations are already consumed; `list_annotations` (below) still returns ones the user
hasn't submitted yet.

The user gives feedback by **drawing on items** with the pencil: freehand strokes (circling,
underlining, crossing out, arrows) on an image (or video or HTML item), each with an optional
text note, or a text-only note dropped on a spot. Check them for feedback on what you posted, e.g.
when the user says "see my comments" / "look at what I circled" or before iterating on an image:
`list_annotations {canvas, sessionId?, itemId?}` (pass your `sessionId` for annotations on your
items), or `GET $API/canvases/$CID/annotations?sessionId=$SID` (or `?itemId=`). Each has `text`
(may be empty for a drawing), `author`, `color`, `createdAt`, the `item` (`id`, `title`, `name`,
`group`, `sessionId`, `width`, `height`, `url` of the original file, canvas `link`) and:

- `strokes`: each stroke as a list of `[x, y]` **pixel points in the original image** (CSS px for
  HTML items); `[]` for a text-only note.
- `bbox`: `{x, y, width, height}`, the drawing's bounding box in pixels: what it marks.
- `anchor`: where the note sits (beside the drawing, or a text-only note's spot): `x`/`y`
  normalized to the item (0..1) and `px`/`py` in pixels.

**Look at `markedImageUrl`** (MCP results; over HTTP `GET $API/canvases/$CID/annotations/<id>/image`):
the image (or a video's poster frame) with the strokes drawn on it in the author's colour and the
annotation's number beside them (a ring round the spot for a text-only note). Fetch it to see what
was circled before acting on the text; the strokes and bbox tell you where, precisely.

**Reading annotations consumes them**: once you've read them they disappear from the canvas (people
see them fly into your session's creature), so read them when you're about to act on them, and
act on all you got. `list_annotations` consumes what it returns (results have `"consumed": true`);
pass `keep: true` to just peek. Over HTTP, `GET …/annotations?sessionId=$SID` consumes too
(`&keep=true` peeks); without `sessionId` it only peeks unless you add `&keep=false`. Consumed
annotations wait in the trash for an hour (their `markedImageUrl` keeps working): `restore
{canvas, annotationIds}` (or `POST $API/canvases/$CID/restore {"annotationIds": [...]}`) puts them
back. `get_canvas` lists annotations too (with their bbox), without consuming them.

## MCP server

The same server speaks MCP (Streamable HTTP) at `<base>/mcp`, usually configured in OpenCode as
the `canvas` MCP server. It only provides tools: you don't appear on the canvas yourself (your
creature does, for say and highlight). Tools take a canvas id or URL; the ones that act for your
session take `sessionId` (`$OPENCODE_SESSION_ID`) and `sessionTitle`.

- `post_item {canvas, sessionId, sessionTitle, path | url | html | page (+ path as its screenshot), width?, height?, group?, title?, caption?, name?}`:
  post into your frame (`path` must be absolute, on the canvas server's machine). **Always pass `sessionTitle`.**
- `say {canvas, sessionId, sessionTitle, text}` and `highlight {canvas, sessionId, sessionTitle, target, point? | region? | at?, text?}`:
  queue steps on your creature (see above). Return the step's `id` and `position` in your queue.
- `update_item {itemId, path | url | html | page, width?, height?, name?, title?, caption?, group?}`: replace an
  item's file in place (a new version of the same visual; see "Updating an item") and/or change its
  metadata (`null` clears title, caption, group).
- `delete_item`, `restore`: soft-delete, undo deletes (and bring back consumed annotations with `annotationIds`).
- `list_canvases`, `create_canvas`, `get_canvas` (sessions, groups, items, notes, annotations), `find_items`, `list_notes`.
- `list_annotations {canvas, sessionId?, itemId?, keep?}`: the user's pencil drawings (strokes and bbox in image pixels, optional text, `markedImageUrl` to look at); reading consumes them unless `keep: true` (see above).
- `get_item {itemId, includeImage?, fullSize?}`: see an image or a page's screenshot (or an HTML item's source).
- `get_selection`: what people on the canvas have selected ("look at this"); `get_presence`: who's there.

Users can also "conjure" OpenCode sessions from the browser, which lets them prompt the session
through its creature; that's user-facing, nothing for you to do.
