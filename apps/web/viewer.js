/**
 * 3D G-code viewer using gcode-preview + Three.js
 * Alpine.js component wrapping the gcode-preview library
 *
 * IMPORTANT: Three.js objects (preview, camera, vectors) must NOT be stored
 * as Alpine component properties. Alpine wraps properties in Proxies, but
 * Three.js objects have non-configurable properties (modelViewMatrix, etc.)
 * that break under Proxy wrapping. All Three.js state lives in closure
 * variables instead.
 */

function gcodeViewer(initialJobId, initialFilamentColors = null) {
    // Three.js objects live here — outside Alpine's reactive scope
    let preview = null;
    let initialCameraPos = null;
    let initialControlsTarget = null;
    let resizeHandler = null;

    return {
        // Only plain JS values in Alpine reactive state
        jobId: initialJobId || null,
        filamentColors: initialFilamentColors || [],
        currentLayer: 0,
        totalLayers: 0,
        serverLayerCount: 0,
        showTravel: false,
        loading: false,
        loadingMessage: 'Initializing...',
        error: null,

        /**
         * Alpine.js lifecycle hook — runs on mount
         */
        async init() {
            if (!this.jobId) {
                console.warn('Viewer mounted without job ID');
                this.error = 'No job ID provided';
                return;
            }

            // Fetch job metadata (filament colors + authoritative layer count)
            try {
                const job = await api.getJobStatus(this.jobId);
                if (!this.filamentColors || this.filamentColors.length === 0) {
                    this.filamentColors = job.filament_colors || [];
                }
                this.serverLayerCount = job.metadata?.layer_count || 0;
            } catch (e) {
                console.warn('Could not fetch job metadata:', e);
            }

            // Wait for next frame to ensure DOM has laid out
            await new Promise(resolve => requestAnimationFrame(resolve));
            await this.loadViewer();
        },

        /**
         * Initialize the 3D preview
         */
        async loadViewer() {
            const canvas = this.$refs.canvas;
            if (!canvas) {
                this.error = 'Canvas element not found';
                return;
            }

            // Wait for container to have stable dimensions
            const container = canvas.parentElement;
            let attempts = 0;
            let lastWidth = 0;
            let stableCount = 0;

            while (attempts < 30) {
                const currentWidth = container.clientWidth;
                if (currentWidth >= 100) {
                    if (currentWidth === lastWidth) {
                        stableCount++;
                        if (stableCount >= 2) break;
                    } else {
                        stableCount = 0;
                    }
                }
                lastWidth = currentWidth;
                await new Promise(resolve => requestAnimationFrame(resolve));
                attempts++;
            }

            if (container.clientWidth < 100) {
                this.error = 'Failed to initialize canvas';
                return;
            }

            // Check WebGL support
            const testCanvas = document.createElement('canvas');
            const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
            if (!gl) {
                this.error = 'WebGL is not supported in this browser. Please use a modern browser with hardware acceleration enabled.';
                return;
            }

            try {
                this.loading = true;
                this.loadingMessage = 'Initializing 3D viewer...';

                // Build color array for tools — plain strings, escaped from Alpine proxy
                const colors = this.filamentColors.length > 0
                    ? [...this.filamentColors].map(c => String(c))
                    : ['#3b82f6']; // Default blue

                // Initialize gcode-preview with tool colors array.
                // disableGradient: the default gradient replaces lightness (0.1–0.8)
                // which turns black filament into gray/white (S=0 means no hue preserved).
                preview = GCodePreview.init({
                    canvas: canvas,
                    buildVolume: { x: 270, y: 270, z: 270 },
                    initialCameraPosition: [0, 400, 350],
                    extrusionColor: colors,
                    backgroundColor: '#1a1a1a',
                    renderTravel: false,
                    disableGradient: true,
                    renderTubes: true,
                    extrusionWidth: 0.45,
                });

                // Improve tube lighting for better contrast between adjacent lines.
                // The library's defaults (ambient + overhead point) give flat, uniform
                // illumination. Adding a low-angle directional light creates shadows
                // between toolpaths, making individual lines distinguishable.
                if (preview.scene) {
                    // Replace library's default lights (ambient 0.3π + point π)
                    // with balanced setup that creates contrast without washing out
                    preview.scene.children
                        .filter(c => c.isAmbientLight || c.isPointLight)
                        .forEach(c => preview.scene.remove(c));
                    preview.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
                    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
                    dirLight.position.set(-200, 150, 300); // Low angle from front-left
                    preview.scene.add(dirLight);
                }

                // Match OrcaSlicer mouse controls: left=rotate, middle/right=pan, scroll=zoom
                if (preview.controls) {
                    preview.controls.mouseButtons = {
                        LEFT: THREE.MOUSE.ROTATE,
                        MIDDLE: THREE.MOUSE.PAN,
                        RIGHT: THREE.MOUSE.PAN,
                    };
                }

                // Store initial camera state for reset (in closure)
                initialCameraPos = preview.camera.position.clone();
                initialControlsTarget = preview.controls
                    ? preview.controls.target.clone()
                    : new THREE.Vector3(135, 0, 135);

                // Fetch full G-code via download endpoint
                this.loadingMessage = 'Downloading G-code...';

                const response = await fetch(`/api/jobs/${this.jobId}/download`);
                if (!response.ok) {
                    throw new Error(`Failed to download G-code: HTTP ${response.status}`);
                }

                const gcodeText = await response.text();
                const sizeMB = (gcodeText.length / 1024 / 1024).toFixed(1);
                this.loadingMessage = `Processing G-code (${sizeMB} MB)...`;

                // Comment out non-standard commands that start with T but aren't tool
                // changes (e.g. TIMELAPSE_START, TIMELAPSE_TAKE_FRAME). gcode-preview's
                // parser maps these to gcode="t" which renderLayer misidentifies as tool
                // changes, setting state.t=undefined and breaking multi-color rendering.
                const cleanGcode = gcodeText.replace(/^(T[A-Z_]{2,}\b.*)/gm, '; $1');

                // Parse and render
                preview.processGCode(cleanGcode);

                // Slider uses preview.layers.length for 1:1 rendering control.
                // Server layer count is only used for the display label.
                this.totalLayers = preview.layers.length;

                if (this.totalLayers === 0) {
                    throw new Error('No layers found in G-code');
                }

                // Show all layers initially
                this.currentLayer = this.totalLayers - 1;
                preview.endLayer = this.totalLayers;
                preview.render();

                this.loading = false;
                console.log(`3D viewer initialized: ${this.totalLayers} layers, ${sizeMB} MB, ${colors.length} tool color(s)`);

                // Handle window resize
                resizeHandler = () => {
                    if (!preview) return;
                    const c = this.$refs.canvas;
                    if (!c) return;
                    const cont = c.parentElement;
                    preview.resize(cont.clientWidth, cont.clientHeight);
                };
                window.addEventListener('resize', resizeHandler);

            } catch (err) {
                console.error('Failed to initialize viewer:', err);
                this.error = `Failed to load G-code preview: ${err.message}`;
                this.loading = false;
            }
        },

        /**
         * Display text for layer counter.
         * Uses server layer count (from OrcaSlicer) when available for accurate display,
         * while slider internally uses preview layer count for correct rendering.
         */
        displayLayerText() {
            const displayTotal = this.serverLayerCount > 0 ? this.serverLayerCount : this.totalLayers;
            if (this.serverLayerCount > 0 && this.totalLayers > 0 && this.serverLayerCount !== this.totalLayers) {
                const displayLayer = Math.max(1, Math.round((this.currentLayer + 1) / this.totalLayers * this.serverLayerCount));
                return `${displayLayer} / ${this.serverLayerCount}`;
            }
            return `${this.currentLayer + 1} / ${this.totalLayers}`;
        },

        /**
         * Layer slider change — show layers 1 through (n+1)
         */
        onLayerChange(newLayer) {
            this.currentLayer = newLayer;
            if (!preview) return;
            preview.endLayer = newLayer + 1;
            preview.render();
        },

        /**
         * Navigate to next layer
         */
        nextLayer() {
            if (this.currentLayer < this.totalLayers - 1) {
                this.currentLayer++;
                this.onLayerChange(this.currentLayer);
            }
        },

        /**
         * Navigate to previous layer
         */
        previousLayer() {
            if (this.currentLayer > 0) {
                this.currentLayer--;
                this.onLayerChange(this.currentLayer);
            }
        },

        /**
         * Toggle travel moves visibility
         */
        toggleTravel() {
            if (!preview) return;
            preview.renderTravel = this.showTravel;
            preview.render();
        },

        /**
         * Zoom in by moving camera closer to target
         */
        zoomIn() {
            if (!preview || !preview.controls) return;
            const camera = preview.camera;
            const target = preview.controls.target;
            const dir = new THREE.Vector3().subVectors(target, camera.position).normalize();
            camera.position.addScaledVector(dir, camera.position.distanceTo(target) * 0.2);
            preview.controls.update();
        },

        /**
         * Zoom out by moving camera away from target
         */
        zoomOut() {
            if (!preview || !preview.controls) return;
            const camera = preview.camera;
            const target = preview.controls.target;
            const dir = new THREE.Vector3().subVectors(camera.position, target).normalize();
            camera.position.addScaledVector(dir, camera.position.distanceTo(target) * 0.25);
            preview.controls.update();
        },

        /**
         * Reset camera to initial position
         */
        resetView() {
            if (!preview) return;
            if (initialCameraPos) {
                preview.camera.position.copy(initialCameraPos);
            }
            if (preview.controls && initialControlsTarget) {
                preview.controls.target.copy(initialControlsTarget);
                preview.controls.update();
            }
        },

        /**
         * Cleanup when component is destroyed
         */
        destroy() {
            if (resizeHandler) {
                window.removeEventListener('resize', resizeHandler);
                resizeHandler = null;
            }
            if (preview) {
                preview.dispose();
                preview = null;
            }
            initialCameraPos = null;
            initialControlsTarget = null;
        }
    };
}
