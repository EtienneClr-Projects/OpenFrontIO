# TASK: Create an OpenFront.io Overlay & Map Analyzer Chrome Extension

## Context & Goal

You need to develop a Google Chrome Extension (Manifest V3) that acts as a real-time HUD and map analyzer overlay for the web game [OpenFront.io](https://github.com/openfrontio/OpenFrontIO).

The extension must intercept client-server network traffic (WebSockets and/or HTTP requests) in real time, extract key game data (map layout, player positions, unit stats, resources, events), and render an interactive floating overlay directly on top of the game interface.

---

## Technical Requirements & Architecture

### 1. File Structure

Create the following file structure:

```text
openfront-overlay/
├── manifest.json
├── inject.js
├── content.js
├── overlay.css
└── README.md
```

### 2. Manifest Configuration (`manifest.json`)

- **Manifest Version**: V3.
- **Match Patterns**: C target `https://openfront.io/*` and `https://*.openfront.io/*`.
- **Injection Mode**: `run_at: "document_start"`.
- **Web Accessible Resources**: `inject.js` must be listed so it can be injected into the main execution context (Main World) of the target page.

### 3. Main World Interceptor (`inject.js`)

- Since `content.js` runs in an isolated context, `inject.js` must be injected directly into the DOM (Main World) to monkey-patch `window.WebSocket` and/or `window.fetch` / `XMLHttpRequest`.
- **WebSocket Interception**:
  - Proxy `window.WebSocket`.
  - Capture incoming (`message` event) and outgoing (`send` method) data streams.
  - Convert binary payloads (`ArrayBuffer`, `Blob`) into inspectable arrays/objects or pass structured text/JSON through.
- **IPC Communication**: Send intercept payload events to `content.js` using `window.postMessage({ type: 'OPENFRONT_WS_IN' | 'OPENFRONT_WS_OUT', payload })`.

### 4. Content Script & Logic (`content.js`)

- Inject `inject.js` into `<head>` or `documentElement` as early as possible.
- Listen for `window.addEventListener("message", ...)` to receive network frames.
- **Parser & Decoder**:
  - Analyze the frame format (JSON or binary structure based on OpenFront.io protocols).
  - Maintain an internal state machine representing:
    - Map dimensions and cell/tile status.
    - Active players and scores/rankings.
    - Unit counts, military deployments, or tactical metrics.
- **UI Overlay Rendering**:
  - Create a modern, responsive HTML container `#openfront-overlay-ui`.
  - Provide a floating, draggable, or collapsible HUD with real-time statistics.
  - Optionally support drawing visual indicators over the main game canvas if coordinate data is available.

### 5. Styling (`overlay.css`)

- Provide sleek, dark-themed HUD styling (gaming aesthetic: subtle transparency, backdrop blur, high contrast monospace data readouts).
- Ensure high `z-index` so the overlay floats smoothly above canvas elements without interfering with mouse clicks on the game board (use `pointer-events: none` on sub-containers where appropriate).

---

## Step-by-Step Implementation Instructions

1. **Scaffold Files**: Write clean, commented, and modular JavaScript code for each required file (`manifest.json`, `inject.js`, `content.js`, `overlay.css`).
2. **Network Protocol Parsing**: Implement flexible parsers capable of handling both standard JSON messages and binary data buffers.
3. **DOM Injection**: Ensure the script injection in `content.js` is robust against asynchronous loading and cleans itself up after loading `inject.js`.
4. **Interactive HUD Features**:
   - Total messages count & message rate / latency.
   - Live list of connected players and state indicators.
   - Collapsible UI button (`_` / `X`) to minimize the HUD.
5. **Documentation**: Add a clear `README.md` explaining how to load the unpacked extension in Chrome Developer Mode and how to inspect or adapt the WebSocket parser.

---

## Verification Criteria

- [ ] Extension loads without syntax errors in `chrome://extensions/`.
- [ ] Navigating to OpenFront.io shows the injected message in the browser console.
- [ ] WebSocket messages are intercepted without breaking core game networking or causing disconnects.
- [ ] The HUD overlay renders correctly on screen and updates smoothly as network events arrive.
