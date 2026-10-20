# opencode-canvas

Review canvases for [OpenCode](https://opencode.ai) sessions, running on your own machine. Agents
post the images, videos and HTML pages they make to a canvas; you look them over on an infinite,
live, multiplayer canvas. Agents can queue things for you to look at on their session's creature.
Connected to your local OpenCode, a canvas can also seed itself from your sessions' media, and bring
sessions onto the canvas as creatures you can talk to.

```sh
bunx github:jlongster/opencode-canvas
```

That's all it needs: [Bun](https://bun.sh) (and optionally `ffmpeg`, for video and thumbnails). It
starts a canvas server on `http://localhost:4545`, finds the OpenCode running on your machine and
opens your browser, ready to connect to it: click **Connect** ("Found OpenCode on this machine").
Canvases are stored in `~/.opencode-canvas`.

On a canvas you can then:

- **Seed** an empty canvas from sessions: each gets a frame with its images and videos from the last
  24 hours, or its latest 10 if there are fewer.
- **Conjure** a session (toolbar → Conjure, or `C`): it appears as a creature where your pointer
  is, with its prompt open. `C` over a session's frame (or a long press on touch) brings your
  creature for that session to the pointer; `C` over empty canvas opens the session picker there.
  Click a creature to prompt the session; everyone on the canvas sees it think and reply. Drag your
  own creatures to move them; only their owner can move them.
- Let agents **post** to it, over MCP or HTTP (below), replace what they posted with new versions in
  place, and point you at things: their `say` and `highlight` steps wait on the session's creature
  (a badge, and "N things want your attention" at the top) until you play them through; stepping
  past one marks it done for everyone.
- **Draw on items** (toolbar → pencil, or `P`): draw on an image to circle or mark what you mean,
  then type an optional note (Enter); drawing again on the same item within a couple of seconds
  adds to the same annotation. `T` (or just typing) over an item drops a text-only note there.
  Once an annotation is saved the toolbar goes back to Select.
  Everyone sees them live, and agents read them back with the strokes in the original image's
  pixels, their bounding box, the note, and a rendered image with the strokes drawn on it
  (`list_annotations`). Reading consumes them: once an agent has read your annotations they
  disappear from the canvas, flying into its creature (agents can peek with `keep: true`, and
  `restore` brings them back within an hour). **Submit annotations (N)** on a session's frame
  sends them all to that session as one prompt (notes, pixel boxes, marked images attached),
  through your paired OpenCode, asking it to update those items in place.
- **Arrange frames**: drag a frame by its title to move it, or hide it with the eye on its title.
  The frame count at the bottom left opens a list of every frame, hidden ones included, to show,
  hide and reorder them. The arrangement is shared with everyone on the canvas.

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
  the canvas list or an empty canvas (or Conjure → Connect). If OpenCode runs on another machine,
  use `opencode pair --remote`.
- OpenCode answers pages on `http://localhost:*` out of the box. Served from anywhere else, the
  canvas must be allowed once: `opencode service set cors <site origin>` (this replaces the list of
  extra sites, comma separated).

Creatures you conjure belong to your browser: while one of your tabs has the canvas open it runs
them; otherwise they sleep. Only you can prompt them; others see them and their replies. Creatures
that sessions called up with `say`/`highlight` have no owner until someone conjures that session.

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
to the top of its group, swapped live on open canvases), see what people have selected, read sticky notes and annotations (pencil drawings with optional notes,
with the strokes in image pixels and a marked image: `list_annotations`, which consumes them unless `keep: true`), and `say` / `highlight` to queue things for you to
look at on the session's creature. It's only a tool provider: agents using it don't appear on the
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
