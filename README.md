# opencode-canvas

Review canvases for [OpenCode](https://opencode.ai) sessions, running on your own machine. Agents
post the images, videos and HTML pages they make to a canvas; you look them over on an infinite,
live, multiplayer canvas. Agents can put sticky notes where they want you to look.
Connected to your local OpenCode, a canvas can also fill session frames with their media and HTML, and let
you prompt sessions from their frames and see when they're working.

```sh
bunx github:jlongster/opencode-canvas
```

That's all it needs: [Bun](https://bun.sh) (and optionally `ffmpeg`, for video and thumbnails). It
starts a canvas server on `http://localhost:4545`, finds the OpenCode running on your machine and
opens your browser, ready to connect to it: click **Connect** ("Found OpenCode on this machine").
Canvases are stored in `~/.opencode-canvas`.

On a canvas you can then:

- **Add a session** (the button on an empty canvas, or **Sessions** in the toolbar): its frame fills
  in by itself with what the session involved: the images and videos it output, the HTML files it
  wrote or produced, and media attached to its prompts (the latest 100 media, 30 HTML files).
- **Prompt** a session from its frame: the prompt button on its title (or `C` with the pointer over
  the frame, or with it or something in it selected) opens its prompt there: your last prompt, its
  reply, and the input. While a session works, a band of embers crawls round its frame, for
  everyone on the canvas, and resolves into a bright rim when it's done. Questions and permission
  requests it asks show at its frame as soon as it asks (a chip at the screen's edge points to it
  when it's off screen). **Sessions** (top right) lists the sessions of every paired OpenCode in
  one list, most recently active first: pick one to add its frame, or to go to it.
- Let agents **post** to it, over MCP or HTTP (below), replace what they posted with new versions in
  place, and point you at things: `say` and `highlight` place a sticky note from the session (its
  colour and title) where it wants you to look. A `say` goes at the top of the session's frame; a
  `highlight` goes right next to what it points at, with a pointer to the exact point or region it
  means, and follows it as the canvas rearranges. **✓ Got it** on a note acknowledges it, which
  removes it for everyone. "N things want your attention" at the top counts the notes, broken down
  by session (with questions and permission requests sessions ask), and its arrows step you through
  them: the camera glides to each note and what it points at.
- **Draw on items** (toolbar → pencil, or `P`): draw on an image to circle or mark what you mean,
  then type an optional note (Enter); drawing again on the same item within a couple of seconds
  adds to the same annotation. `T` (or just typing) over an item drops a text-only note there.
  Once an annotation is saved the toolbar goes back to Select.
  Everyone sees them live, and agents read them back with the strokes in the original image's
  pixels, their bounding box, the note, and a rendered image with the strokes drawn on it
  (`list_annotations`). Reading consumes them: once an agent has read your annotations they
  disappear from the canvas, flying into its frame's title (agents can peek with `keep: true`, and
  `restore` brings them back within an hour). **Submit annotations (N)** on a session's frame
  sends them all to that session as one prompt (notes, pixel boxes, marked images attached),
  through your paired OpenCode, asking it to update those items in place.
- **Give a session your own media**: drop (or paste, pointing at it) images, videos or HTML files
  onto a session's frame and they become items there, marked with who added them. A small badge
  says whether the session has them yet: a hollow ring until they're sent, a filled dot once it
  has them. They go along with your next **Submit annotations** (the pill says `· +N images`: the
  originals, scaled to fit 1600 px, before the marked images; a video as a contact sheet of 6
  frames) or your next prompt from the frame (shown as "From the frame" chips you can remove), and
  again after the session compacts. The session is told they're references from you, not its own
  output, so it doesn't overwrite them. Dropping files anywhere else on the canvas does nothing.
- **Put a web page on it**: paste a link (Cmd/Ctrl+V of an `http(s)` URL, anywhere on an edit link
  outside a text field) and a link card for it lands in the canvas's **Pasted links** frame.
  Page items show a screenshot when the poster sent one (with the site's domain in a corner), else
  a link card; **Open** opens the real page in a new tab. Agents post them too (`page` below), with
  a screenshot. The canvas never fetches the page itself.
- **Arrange frames**: drag a frame by its title to move it, or hide it with the eye on its title;
  **Sessions** lists the hidden ones, to show them again. The arrangement is shared with everyone
  on the canvas.

## Options

```
bunx github:jlongster/opencode-canvas [canvas-url-or-id] [options]

  canvas-url-or-id        a canvas to open (an id, or a …/c/<id> or …/v/<viewKey> link);
                          without one, the canvas list
  --port <n>              port (default 4545; pairings are remembered per origin, so keep it)
  --host <address>        address to listen on (default 127.0.0.1: this machine only)
  --data <dir>            where canvases and media are stored (default ~/.opencode-canvas)
  --canvas-server <url>   use a remote canvas server instead: only the web app is served locally
  --no-open               print the link, don't open a browser
  -h, --help / -v, --version
```

Running it again while it's already running on the port just prints (and opens) a fresh link to
connect with.

## Connecting OpenCode

Your browser is the only thing that talks to OpenCode; the canvas server never does.

- At startup the command asks your OpenCode for a one-time pairing code and puts it in the link it
  opens (`…#pair=…`). The page takes the code out of the URL right away and keeps it in memory;
  clicking **Connect** redeems it for a token kept in this browser's localStorage (per origin, so
  keep using the same port). A link never connects the browser by itself.
- No OpenCode running, or the code expired? Run `opencode pair` and paste the link it prints into
  the canvas list or an empty canvas (or Sessions → Connect). If OpenCode runs on another machine,
  use `opencode pair --remote`.
- OpenCode answers pages on `http://localhost:*` out of the box. Served from anywhere else, the
  canvas must be allowed once: `opencode service set cors <site origin>` (this replaces the list of
  extra sites, comma separated).

Each frame **is** an OpenCode session. Your browser, paired with the OpenCode it's on, titles the
frame after the session when the canvas loads and follows it live: rename the session in any
OpenCode client and the frame (and its notes, and the Sessions list) follow within a moment; a
session deleted in OpenCode keeps its frame and items, marked as ended. Your browser also tells the
canvas server, which passes it on, so everyone sees the same titles, paired or not (and so do you
when no paired tab is open). The canvas keeps only its own state for each session: its items,
groups, notes, order and whether it's hidden. The title an agent posts with (`sessionTitle`) is
just a fallback until then.

Prompting a session from its frame links it to your browser: while one of your tabs has the canvas
open, it talks to that session's OpenCode and tells everyone whether it's working (the busy band)
and shares its replies. Only you can prompt it; others see it work and reply.

## Use it from your agents

Give your agents the skill (when and how to post: groups, titles, HTML diagrams, …) and the MCP
server (the tools).

**The skill**: [`skill/canvas/SKILL.md`](skill/canvas/SKILL.md). Copy it into your OpenCode skills,
straight from GitHub:

```sh
mkdir -p ~/.config/opencode/skills/canvas
curl -fsSL https://raw.githubusercontent.com/jlongster/opencode-canvas/master/skill/canvas/SKILL.md \
  -o ~/.config/opencode/skills/canvas/SKILL.md
```

or from a checkout, symlinked so it stays up to date:

```sh
mkdir -p ~/.config/opencode/skills
ln -s "$PWD/skill/canvas" ~/.config/opencode/skills/canvas
```

**The MCP server**: the canvas server is an MCP server (Streamable HTTP) at
`http://localhost:4545/mcp`, with tools to list and create canvases, post, update and delete items
(`update_item` replaces an item's image, video or HTML in place: same id, place and comments, moved
to the top of its group, swapped live on open canvases; `sessionTitle` is optional, see above), post links to web pages (`post_item` with
`page`, its URL, plus a screenshot as `path`; `url` is for media files), see what people have selected, read sticky notes and annotations (pencil drawings with optional notes,
with the strokes in image pixels and the marked images returned as images: `list_annotations`, which consumes them unless `keep: true`; items people dragged in show `origin: "person"` and `addedBy`), and `say` / `highlight` to place a sticky
note where they want you to look (you acknowledge it to remove it). It's only a tool provider: agents using it don't appear on the
canvas themselves. In your OpenCode config:

```json
{ "mcp": { "canvas": { "type": "remote", "url": "http://localhost:4545/mcp" } } }
```

**Another canvas server** (a different `--port`, or a self-hosted one): point the MCP `url` at
`<server>/mcp`, and set `CANVAS_URL=<server>` in the environment OpenCode runs in; the skill uses it
instead of `http://localhost:4545` (it also follows the canvas link you give the agent).

There's a plain HTTP API too: `GET http://localhost:4545/api` describes it. For example:

```sh
curl -X POST http://localhost:4545/api/canvases/<canvas id>/sessions/$OPENCODE_SESSION_ID/items \
  -F file=@output.png -F caption="first try"
```

### Web page links

To post a link, use `page` with the URL and include a screenshot of it (`path`/`file`) whenever you
can — take one with your browser tooling; the canvas never fetches the URL itself. Without a
screenshot it shows as a link card (the title or host, the URL and **Open ↗**). Since nothing is
fetched, any address works: localhost, Tailscale, private networks. `update_item` with a new `path`
swaps the screenshot; with `page`, it points the item at another URL.

## Self-hosting

The server is `server/index.ts` (Bun, no build step); it serves the API, media, live rooms, MCP and
the web app in `web/dist`.

```sh
bun install
PORT=4410 CANVAS_DATA=./data CANVAS_WEB=https://example.com/canvas bun server/index.ts
```

- `PORT` (default 4410), `CANVAS_HOST` (address to listen on; default all), `CANVAS_DATA` (default
  `./data`).
- `CANVAS_WEB`: the public URL people open canvases at, used in links (MCP results, the API index);
  `CANVAS_MEDIA_ORIGIN`: the origin absolute media URLs use (default `http://localhost:<PORT>`);
  `CANVAS_ORIGINS`: extra page origins allowed to open live sockets (comma separated).
- It answers under `/canvas/…` as well as `/`, so it can sit behind a proxy at `/canvas`.
- To use your OpenCode with it, allow the site in OpenCode (`opencode service set cors <origin>`)
  and pair with `opencode pair`; or run `bunx github:jlongster/opencode-canvas --canvas-server <url>`
  to serve the app from localhost against it.

## Development

```sh
bun install
bun run dev          # API server (:4410) + Vite dev server (:5173)
bun run local        # the bunx command, from this checkout
bun run typecheck
```

`bunx github:jlongster/opencode-canvas` installs this repository's root package (runtime
dependencies only, no build step) and serves the committed `web/dist`. So after changing anything
in `web/`, run `bun run build` and commit `web/dist`; `bun run check:build` fails if it's stale.
