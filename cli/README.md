# opencode-canvas

Open review canvases in your browser, connected to the OpenCode running on your machine.

```sh
bunx opencode-canvas                                        # the canvas list
bunx opencode-canvas Ab3dEf7hJk                             # a canvas by id
bunx opencode-canvas https://jamesbox.exe.xyz/canvas/c/Ab3dEf7hJk   # or by link
```

It serves the canvas app on `http://localhost:4545`, finds your local OpenCode, and opens the
browser already connected to it. On the canvas you can then:

- **Conjure** a session (toolbar → Conjure): it appears as a worm. Click it to prompt the session;
  everyone on the canvas sees it think and reply. Drag it anywhere.
- **Seed** an empty canvas from sessions: each gets a frame with the images and videos it output in
  the last 24 hours.

## How it works

- Canvases live on a shared canvas server (default `https://jamesbox.exe.xyz/canvas`). The app
  served on localhost uses it for canvases, media and live presence.
- Your browser is the only thing that talks to OpenCode. OpenCode allows `http://localhost:*` pages
  by default, which is why the app is served locally.
- At startup the CLI asks your OpenCode for a one-time pairing code and puts it in the link it
  opens (`…#pair=…`). The page redeems it for a token, keeps the token in this browser's
  localStorage (per origin, so keep using the same port), and removes the code from the URL. The CLI
  and the canvas server never see the token; the canvas server never talks to OpenCode.
- Worms you conjure belong to your browser. While a tab of yours has the canvas open, that tab runs
  them (listens to OpenCode and shares their presence); otherwise they sleep. Only you can prompt
  them; others see them and their replies.
- The local server is static: it serves the bundled app and nothing else, on 127.0.0.1 only.

## Options

```
bunx opencode-canvas [canvas-url-or-id] [options]

  --port <n>              local port (default 4545; pairings are remembered per port)
  --canvas-server <url>   canvas server to use (default https://jamesbox.exe.xyz/canvas, or the
                          server of the canvas link you pass)
  --no-open               just print the link, don't open a browser
  -h, --help              help
  -v, --version           version
```

If OpenCode isn't running, the app still opens; start OpenCode and run the command again, or run
`opencode pair` and paste the link into the canvas (Conjure → Connect your OpenCode).

Running it again while it's already serving the port just opens a fresh pairing link.

## Building

From the canvas repository: `cd cli && bun run build`. That builds the web app (`web/dist`), copies
it to `cli/app/` and bundles the CLI into `cli/dist/cli.js` (Node ≥ 20 or Bun; no runtime
dependencies).
