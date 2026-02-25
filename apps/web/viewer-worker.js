/**
 * Web Worker for off-thread G-code download and text processing.
 *
 * Handles: fetch with streaming progress → TIMELAPSE regex cleaning →
 * line splitting → posting chunks back to main thread.
 *
 * The main thread never touches the raw G-code text, keeping the UI
 * responsive even for 100MB+ files.
 */

const CHUNK_SIZE = 5000; // Lines per chunk posted to main thread

self.onmessage = async function (e) {
    const { type, url } = e.data;
    if (type !== 'start') return;

    try {
        // --- Phase 1: Download with progress ---
        self.postMessage({ type: 'progress', phase: 'download', percent: 0 });

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
        const decimationFactor = parseInt(response.headers.get('x-decimation-factor') || '1', 10);
        const originalSize = parseInt(response.headers.get('x-original-size') || '0', 10);

        let text;
        if (response.body && response.body.getReader) {
            // Stream download with progress reporting.
            // Works with or without Content-Length (StreamingResponse may omit it).
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parts = [];
            let received = 0;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                parts.push(decoder.decode(value, { stream: true }));
                received += value.length;
                if (contentLength > 0) {
                    const pct = Math.min(99, Math.round(received / contentLength * 100));
                    self.postMessage({ type: 'progress', phase: 'download', percent: pct });
                } else {
                    // No Content-Length — show MB received
                    const mb = (received / 1024 / 1024).toFixed(1);
                    self.postMessage({ type: 'progress', phase: 'download', percent: -1, receivedMB: mb });
                }
            }
            // Flush decoder
            parts.push(decoder.decode());
            text = parts.join('');
        } else {
            // Fallback: no streaming support (very old browsers)
            text = await response.text();
        }
        self.postMessage({ type: 'progress', phase: 'download', percent: 100 });

        // --- Phase 2: Clean TIMELAPSE commands ---
        self.postMessage({ type: 'progress', phase: 'processing', percent: 0 });

        // Comment out non-standard T-commands (TIMELAPSE_START, etc.) that
        // gcode-preview misidentifies as tool changes.
        text = text.replace(/^(T[A-Z_]{2,}\b.*)/gm, '; $1');

        self.postMessage({ type: 'progress', phase: 'processing', percent: 50 });

        // --- Phase 3: Split into lines and post chunks ---
        const lines = text.split('\n');
        text = null; // Free memory

        const totalChunks = Math.ceil(lines.length / CHUNK_SIZE);

        for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
            const chunk = lines.slice(i, i + CHUNK_SIZE);
            const chunkIndex = Math.floor(i / CHUNK_SIZE);
            self.postMessage({
                type: 'chunk',
                lines: chunk,
                chunkIndex,
                totalChunks,
            });
        }

        self.postMessage({
            type: 'done',
            totalLines: lines.length,
            decimationFactor,
            originalSize,
        });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
