/**
 * Main Application Logic
 * Alpine.js component for U1 Slicer Bridge UI
 */

function app() {
    return {
        // UI State
        dragOver: false,
        uploadProgress: 0,
        error: null,

        // Current workflow step: 'upload' | 'configure' | 'slicing' | 'complete'
        currentStep: 'upload',

        // Data
        uploads: [],
        filaments: [],
        selectedUpload: null,     // Current upload object
        selectedFilament: null,   // Selected filament ID

        // Printer status
        printerConnected: false,
        printerStatus: 'Checking...',

        // Slicing settings
        sliceSettings: {
            layer_height: 0.2,
            infill_density: 15,
            supports: false,
        },

        // Results
        sliceResult: null,
        sliceProgress: 0,         // Progress percentage (0-100)

        // Polling interval
        sliceInterval: null,

        /**
         * Initialize the application
         */
        async init() {
            console.log('U1 Slicer Bridge - Initializing...');

            // Load initial data
            await this.checkPrinterStatus();
            await this.loadFilaments();
            await this.loadRecentUploads();

            // Set up periodic printer status check
            setInterval(() => this.checkPrinterStatus(), 30000); // Every 30 seconds
        },

        /**
         * Check printer connection status
         */
        async checkPrinterStatus() {
            try {
                const status = await api.getPrinterStatus();
                this.printerConnected = status.connected;
                this.printerStatus = status.connected ? 'Connected' : 'Offline';
            } catch (err) {
                this.printerConnected = false;
                this.printerStatus = 'Error';
                console.error('Failed to check printer status:', err);
            }
        },

        /**
         * Load filaments from API
         */
        async loadFilaments() {
            try {
                const response = await api.listFilaments();
                this.filaments = response.filaments || [];
                console.log(`Loaded ${this.filaments.length} filaments`);
            } catch (err) {
                this.showError('Failed to load filaments');
                console.error(err);
            }
        },

        /**
         * Initialize default filaments
         */
        async initDefaultFilaments() {
            try {
                await api.initDefaultFilaments();
                await this.loadFilaments();
                console.log('Default filaments initialized');
            } catch (err) {
                this.showError('Failed to initialize default filaments');
                console.error(err);
            }
        },

        /**
         * Load recent uploads
         */
        async loadRecentUploads() {
            try {
                const response = await api.listUploads();
                this.uploads = response.uploads || [];
                console.log(`Loaded ${this.uploads.length} recent uploads`);
            } catch (err) {
                this.showError('Failed to load uploads');
                console.error(err);
            }
        },

        /**
         * Handle file drop
         */
        handleFileDrop(event) {
            this.dragOver = false;
            const files = event.dataTransfer.files;
            if (files.length > 0) {
                this.handleFileUpload(files[0]);
            }
        },

        /**
         * Handle file select from input
         */
        handleFileInput(event) {
            const files = event.target.files;
            if (files.length > 0) {
                this.handleFileUpload(files[0]);
            }
        },

        /**
         * Handle file upload (Step 1)
         */
        async handleFileUpload(file) {
            // Validate file type
            if (!file.name.endsWith('.3mf')) {
                this.showError('Please upload a .3mf file');
                return;
            }

            console.log(`Uploading: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
            this.currentStep = 'upload';
            this.uploadProgress = 0;

            try {
                const result = await api.uploadFile(file, (progress) => {
                    this.uploadProgress = progress;
                });

                console.log('Upload complete:', result);
                this.uploadProgress = 0;

                // Add to uploads list
                this.uploads.unshift(result);

                // Select this upload and move to configure step
                this.selectedUpload = result;
                this.currentStep = 'configure';

                // Auto-select default filament
                const defaultFilament = this.filaments.find(f => f.is_default);
                if (defaultFilament) {
                    this.selectedFilament = defaultFilament.id;
                }
            } catch (err) {
                this.uploadProgress = 0;
                this.showError(`Upload failed: ${err.message}`);
                console.error(err);
            }
        },

        /**
         * Select an existing upload (from recent uploads list)
         */
        selectUpload(upload) {
            console.log('Selected upload:', upload.upload_id);
            this.selectedUpload = upload;
            this.currentStep = 'configure';

            // Auto-select default filament if not already selected
            if (!this.selectedFilament) {
                const defaultFilament = this.filaments.find(f => f.is_default);
                if (defaultFilament) {
                    this.selectedFilament = defaultFilament.id;
                }
            }
        },

        /**
         * Start slicing (Step 3)
         */
        async startSlice() {
            if (!this.selectedUpload || !this.selectedFilament) {
                this.showError('Please select an upload and filament');
                return;
            }

            console.log('Starting slice for upload:', this.selectedUpload.upload_id);
            console.log('Settings:', this.sliceSettings);

            this.currentStep = 'slicing';
            this.sliceProgress = 0;

            try {
                const result = await api.sliceUpload(this.selectedUpload.upload_id, {
                    filament_id: this.selectedFilament,
                    ...this.sliceSettings
                });

                console.log('Slice started:', result);

                if (result.status === 'completed') {
                    // Synchronous slicing (completed immediately)
                    this.sliceResult = result;
                    this.sliceProgress = 100;
                    this.currentStep = 'complete';
                } else {
                    // Async slicing - poll for completion
                    this.pollSliceStatus(result.job_id);
                }
            } catch (err) {
                this.showError(`Slicing failed: ${err.message}`);
                this.currentStep = 'configure';
                console.error(err);
            }
        },

        /**
         * Poll slicing job status
         */
        pollSliceStatus(jobId) {
            if (this.sliceInterval) {
                clearInterval(this.sliceInterval);
            }

            this.sliceInterval = setInterval(async () => {
                try {
                    const job = await api.getJobStatus(jobId);
                    console.log('Slice status:', job.status);

                    // Increment progress (fake progress since API doesn't provide real progress)
                    this.sliceProgress = Math.min(90, this.sliceProgress + 5);

                    if (job.status === 'completed') {
                        clearInterval(this.sliceInterval);
                        this.sliceResult = job;
                        this.sliceProgress = 100;
                        this.currentStep = 'complete';
                        console.log('Slicing completed');
                    } else if (job.status === 'failed') {
                        clearInterval(this.sliceInterval);
                        this.showError(`Slicing failed: ${job.error_message || 'Unknown error'}`);
                        this.currentStep = 'configure';
                    }
                } catch (err) {
                    console.error('Failed to check slice status:', err);
                }
            }, 2000); // Poll every 2 seconds
        },

        /**
         * Reset workflow to start over
         */
        resetWorkflow() {
            this.currentStep = 'upload';
            this.selectedUpload = null;
            this.sliceResult = null;
            this.sliceProgress = 0;

            if (this.sliceInterval) {
                clearInterval(this.sliceInterval);
                this.sliceInterval = null;
            }
        },

        /**
         * Format time in seconds to human readable string
         */
        formatTime(seconds) {
            if (!seconds) return '0h 0m';
            const hours = Math.floor(seconds / 3600);
            const minutes = Math.floor((seconds % 3600) / 60);
            return `${hours}h ${minutes}m`;
        },

        /**
         * Format filament length in mm to meters
         */
        formatFilament(mm) {
            if (!mm) return '0.0m';
            return `${(mm / 1000).toFixed(1)}m`;
        },

        /**
         * Show error message
         */
        showError(message) {
            this.error = message;
            setTimeout(() => {
                this.error = null;
            }, 5000); // Auto-dismiss after 5 seconds
        },

        /**
         * Cleanup intervals on destroy
         */
        destroy() {
            if (this.sliceInterval) {
                clearInterval(this.sliceInterval);
            }
        },
    };
}
