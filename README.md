# MeshCore Web Key Generator (Enhanced Edition)

A robust, high-performance web application that generates Ed25519 keys compatible with MeshCore. All computations execute entirely locally in your browser.

> 🚀 **Enhanced Edition**: This is a modernized and modularized continuation based on the excellent original work by [agessaman](https://github.com/agessaman/meshcore-web-keygen).

## ✨ What's New in this Version?

- **JSON API Endpoint (`json-api.html`)**: A dedicated headless endpoint that allows other web or mobile applications to generate keys programmatically using URL parameters (`?prefix=...`) and the browser's `postMessage` architecture.
- **Decoupled Architecture**: The heavy-lifting WebAssembly generation logic has been extracted into a reusable, standalone module (`js/meshcore-engine.js`).
- **Modern UI & Theme Support**: Completely redesigned responsive interface featuring a "Neon MeshCore" aesthetic, complete with a persistent Light/Dark mode switcher.
- **Improved Instructions**: Highly readable step-by-step documentation with accurate screenshots for directly importing your keys into MeshCore.

## 📖 What it does

Generates secure Ed25519 cryptography key pairs where the public key begins with a specific hex prefix. MeshCore uses the first two characters of the public key as a node identifier. By generating a custom key, you can assign your node a specific ID and avoid collisions with neighboring nodes.

## 🚀 Usage

### Standard Web Interface
The easiest way to generate a key is via the UI:

1. **Serve the project properly:** Because the generator relies on WebAssembly (Wasm) and ES Modules, you must run it using a local server, e.g. `npx serve` or `python -m http.server`. It strictly will not run by just double-clicking `index.html` (due to standard CORS security policies).
2. Open `index.html` in a web browser.
3. Enter a hex prefix (e.g., "F8", "F8A1").
4. Click "Generate Key".
5. Wait for the engine to find the match, then download your JSON or copy the keys.

### JSON API Engine (Programmatic Access)

For third-party systems (like an onboarding wizard or mobile app WebView), you can silently invoke key generation without loading the main user interface.

**Endpoint:** `json-api.html`
- Access via `json-api.html?prefix=FA`
- **Output:** Returns pure JSON in the DOM, or broadcasts via `window.postMessage`.

**Example Usage via iframe:**
```javascript
const iframe = document.createElement('iframe');
iframe.style.display = 'none';

// Listen for the result from the invisible API
window.addEventListener("message", (event) => {
    if (event.data && event.data.type === 'KEY_GENERATED') {
        console.log("Found Key!", event.data.payload);
        // returns { seed, publicKey, privateKey, attempts, timeElapsed }
    }
});

// Start the search
iframe.src = 'http://localhost/json-api.html?prefix=F8';
document.body.appendChild(iframe);
```

## 🔑 Key Format

- **Seed**: 32 bytes (64 hex characters) // Added in this version!
- **Private Key**: 64 bytes (128 hex characters)
- **Public Key**: 32 bytes (64 hex characters)

## ⚡ Performance Matrix

Under the hood, this generator utilizes WebAssembly (compiled from Rust) and heavily parallelizes the generation workload using Web Workers to find your requested prefix.

Baseline expectations (~100,000 keys/second on modern standard hardware):
- 1-character prefix: < 0.01 seconds
- 2-character prefix: ~0.003 seconds
- 3-character prefix: ~0.04 seconds
- 4-character prefix: ~0.7 seconds
- 5-character prefix: ~10 seconds
- 6-character prefix: ~3 minutes
- 7-character prefix: ~45 minutes

## 🌐 Browser Support

Chrome 60+, Firefox 55+, Safari 11+, Edge 79+. 
*Note: A modern browser that supports WebAssembly and Web Workers is required.*

## 📥 Importing to MeshCore

### Companion Nodes
1. Connect to your node using the MeshCore app
2. Tap the Settings gear icon
3. Tap "Manage Identity Key"
4. Paste your **Private Key** into the text box
5. Tap "Import Private Key" and hit the checkmark ✓ to save

### Repeater Nodes (via Serial)
1. Open the [MeshCore Web Console](https://flasher.meshcore.co.uk/)
2. Run the command: `set prv.key <your_private_key_hex>`
3. The device will dynamically reboot with your new identity

## 🔒 Security Guarantee

- All cryptographic processing happens strictly within your local browser environment.
- No network requests are made during generation.
- The Wasm execution doesn't phone home.
- Your keys never leave your device.
