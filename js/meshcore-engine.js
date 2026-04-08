let nobleEd25519 = null;

export class MeshCoreKeyGenerator {
    constructor() {
        this.isRunning = false;
        this.stopRequested = false;
        this.attempts = 0;
        this.startTime = null;
        this.lastUpdateTime = null;
        this.updateInterval = null;
        this.initialized = false;
        this.workers = [];
        this.numWorkers = navigator.hardwareConcurrency || 4;
        this.batchSize = 4096; // Initial per-worker batch size
        this.targetBatchMs = 20;
        this.minBatchSize = 512;
        this.maxBatchSize = 65536;
        this.progressIntervalMs = 150;
        this.currentJobId = 0;
        this.activeSearch = null;
        this.generationMode = 'wasm';
        this.jsFallbackModule = null;
        this.jsFallbackReason = null;
        this.perfDebug = new URLSearchParams(window.location.search).get('perfDebug') === '1';
        this.perfStats = this.createEmptyPerfStats();
    }

    createEmptyPerfStats() {
        return {
            messages: 0,
            batches: 0,
            wasmMs: 0,
            batchWallMs: 0,
            startedAt: 0,
            lastLogAt: 0
        };
    }

    resetPerfStats() {
        this.perfStats = this.createEmptyPerfStats();
        this.perfStats.startedAt = performance.now();
    }

    recordPerfMetrics(metrics) {
        if (!metrics) return;
        this.perfStats.messages += 1;
        this.perfStats.batches = Math.max(this.perfStats.batches, metrics.batchCount || 0);
        this.perfStats.wasmMs += metrics.wasmMs || 0;
        this.perfStats.batchWallMs += metrics.batchWallMs || 0;
    }

    getPerfSnapshot(elapsedSeconds) {
        const elapsed = Math.max(elapsedSeconds, 0.001);
        const avgBatch = this.perfStats.batches > 0 ? this.attempts / this.perfStats.batches : 0;
        const msgPerSec = this.perfStats.messages / elapsed;
        const overheadMs = Math.max(0, this.perfStats.batchWallMs - this.perfStats.wasmMs);
        const overheadShare = this.perfStats.batchWallMs > 0 ? overheadMs / this.perfStats.batchWallMs : 0;
        const wasmShare = this.perfStats.batchWallMs > 0 ? this.perfStats.wasmMs / this.perfStats.batchWallMs : 0;
        return {
            avgBatch,
            msgPerSec,
            overheadMs,
            overheadShare,
            wasmShare
        };
    }

    async initialize() {
        if (!this.initialized) {
            let libraryUrl = null;
            try {
                // Use unpkg.com for the latest version (recommended)
                libraryUrl = 'https://unpkg.com/noble-ed25519@latest';
                nobleEd25519 = await import(libraryUrl);
                this.initialized = true;
                console.log('✓ noble-ed25519 library loaded successfully from unpkg.com');
                console.log('Available functions:', Object.keys(nobleEd25519));
            } catch (error) {
                console.warn('Failed to load from unpkg.com, trying jsDelivr:', error.message);
                try {
                    // Fallback to jsDelivr
                    libraryUrl = 'https://cdn.jsdelivr.net/npm/noble-ed25519@latest';
                    nobleEd25519 = await import(libraryUrl);
                    this.initialized = true;
                    console.log('✓ noble-ed25519 library loaded successfully from jsDelivr');
                    console.log('Available functions:', Object.keys(nobleEd25519));
                } catch (fallbackError) {
                    console.warn('Failed to load from jsDelivr, trying esm.sh:', fallbackError.message);
                    try {
                        // Fallback to esm.sh (alternative CDN)
                        libraryUrl = 'https://esm.sh/noble-ed25519@latest';
                        nobleEd25519 = await import(libraryUrl);
                        this.initialized = true;
                        console.log('✓ noble-ed25519 library loaded successfully from esm.sh');
                        console.log('Available functions:', Object.keys(nobleEd25519));
                    } catch (esmError) {
                        console.warn('Failed to load from esm.sh, trying Skypack:', esmError.message);
                        try {
                            // Fallback to Skypack
                            libraryUrl = 'https://cdn.skypack.dev/noble-ed25519';
                            nobleEd25519 = await import(libraryUrl);
                            this.initialized = true;
                            console.log('✓ noble-ed25519 library loaded successfully from Skypack');
                            console.log('Available functions:', Object.keys(nobleEd25519));
                        } catch (skypackError) {
                            console.warn('Failed to load from Skypack, trying offline fallback:', skypackError.message);
                            try {
                                // Final fallback: offline version
                                libraryUrl = './noble-ed25519-offline-simple.js';
                                nobleEd25519 = await import(libraryUrl);
                                this.initialized = true;
                                console.log('✓ noble-ed25519 library loaded successfully (offline fallback)');
                                console.log('Available functions:', Object.keys(nobleEd25519));
                            } catch (offlineError) {
                                console.error('Failed to load noble-ed25519 library from all sources:', offlineError);
                                throw new Error('Failed to load Ed25519 library. Please check your internet connection and ensure noble-ed25519-offline-simple.js is available.');
                            }
                        }
                    }
                }
            }
            
            // Store the library URL for workers to use (they'll import from the same URL)
            this.libraryUrl = libraryUrl;

            // Initialize Web Workers with WASM acceleration
            if (typeof WebAssembly === 'undefined') {
                await this.loadJsFallback('WebAssembly is not available in this browser.');
            } else {
                try {
                    await this.initializeWorkers();
                } catch (workerInitError) {
                    await this.loadJsFallback(`WASM worker init failed: ${workerInitError.message}`);
                }
            }
            this.initialized = true;
        }
    }

    async initializeWorkers() {
        if (this.workers.length > 0) return; // Already initialized

        try {
            for (let i = 0; i < this.numWorkers; i++) {
                const worker = new Worker('./wasm/worker.js', { type: 'module' });
                const workerInfo = {
                    id: i,
                    worker,
                    attemptedTotal: 0
                };
                worker.addEventListener('message', (e) => this.handleWorkerMessage(workerInfo, e.data));
                worker.addEventListener('error', (error) => this.handleWorkerError(workerInfo, error));
                this.workers.push(workerInfo);
            }
        } catch (error) {
            await this.cleanupWorkers();
            throw error;
        }
        this.useFastWorkers = true;
        this.generationMode = 'wasm';
        console.log(`✓ Initialized ${this.numWorkers} WASM-accelerated Web Workers`);
    }

    async loadJsFallback(reason) {
        if (!this.jsFallbackModule) {
            this.jsFallbackModule = await import('./fallback-keygen.js');
        }
        this.generationMode = 'js-fallback';
        this.jsFallbackReason = reason || 'WASM unavailable';
        console.warn(`Using JS fallback key generation: ${this.jsFallbackReason}`);
    }

    async cleanupWorkers() {
        for (const workerInfo of this.workers) {
            workerInfo.worker.terminate();
        }
        this.workers = [];
    }

    // Convert Uint8Array to hex string
    toHex(bytes) {
        if (!(bytes instanceof Uint8Array)) {
            console.error('toHex: bytes is not Uint8Array:', typeof bytes, bytes);
            return '';
        }
        const hex = Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        return hex;
    }

    // Check if public key matches the target prefix
    checkPrefix(publicKeyHex, targetPrefix) {
        return publicKeyHex.startsWith(targetPrefix.toUpperCase());
    }

    handleWorkerError(workerInfo, error) {
        console.warn(`Worker ${workerInfo.id} failed:`, error);
        if (this.activeSearch && !this.activeSearch.done) {
            this.activeSearch.failures += 1;
            if (this.activeSearch.failures >= this.workers.length) {
                const activeSearch = this.activeSearch;
                activeSearch.done = true;
                this.activeSearch = null;
                activeSearch.reject(new Error('All workers failed during generation.'));
            }
        }
    }

    handleWorkerMessage(workerInfo, data) {
        if (!this.activeSearch || data.jobId !== this.activeSearch.jobId) {
            return;
        }

        if (data.metrics) {
            this.recordPerfMetrics(data.metrics);
        }

        if (data.type === 'progress' || data.type === 'match') {
            const newTotal = data.attemptedTotal ?? (workerInfo.attemptedTotal + (data.attemptedDelta || 0));
            const delta = Math.max(0, newTotal - workerInfo.attemptedTotal);
            workerInfo.attemptedTotal = newTotal;
            this.attempts += delta;
        }

        if (data.type === 'match' && !this.activeSearch.done) {
            this.activeSearch.done = true;
            this.stopRequested = false;
            this.isRunning = false;
            this.stopWorkers();
            const resolve = this.activeSearch.resolve;
            this.activeSearch = null;
            resolve(data.result);
            return;
        }

        if (data.type === 'stopped') {
            this.activeSearch.stopped += 1;
            if (this.activeSearch.stopped >= this.workers.length && !this.activeSearch.done) {
                const activeSearch = this.activeSearch;
                activeSearch.done = true;
                this.activeSearch = null;
                if (this.stopRequested) {
                    activeSearch.resolve(null);
                } else {
                    activeSearch.reject(new Error('Search ended without a match.'));
                }
            }
        }
    }

    stopWorkers() {
        for (const workerInfo of this.workers) {
            workerInfo.worker.postMessage({ type: 'stop' });
        }
    }

    startWorkerSearch(targetPrefix) {
        if (this.workers.length === 0) {
            return Promise.reject(new Error('No workers available for key generation.'));
        }

        this.currentJobId += 1;
        for (const workerInfo of this.workers) {
            workerInfo.attemptedTotal = 0;
        }
        this.resetPerfStats();

        const jobId = this.currentJobId;
        return new Promise((resolve, reject) => {
            this.activeSearch = {
                jobId,
                done: false,
                stopped: 0,
                failures: 0,
                resolve,
                reject
            };

            for (const workerInfo of this.workers) {
                workerInfo.worker.postMessage({
                    type: 'start',
                    jobId,
                    targetPrefix,
                    batchSize: this.batchSize,
                    adaptiveBatching: true,
                    targetBatchMs: this.targetBatchMs,
                    minBatchSize: this.minBatchSize,
                    maxBatchSize: this.maxBatchSize,
                    progressIntervalMs: this.progressIntervalMs,
                    excludedPrefixes: window.excludedPrefixesArray || []
                });
            }
        });
    }

    async startJsFallbackSearch(targetPrefix) {
        await this.loadJsFallback(this.jsFallbackReason || 'WASM path unavailable');
        const fallbackBatchSize = Math.max(64, Math.floor(this.batchSize / 2));
        return this.jsFallbackModule.searchVanityKey({
            targetPrefix,
            excludedPrefixes: window.excludedPrefixesArray || [],
            batchSize: fallbackBatchSize,
            getNobleEd25519: () => nobleEd25519,
            shouldStop: () => this.stopRequested || !this.isRunning,
            onAttempted: (count) => {
                this.attempts += count;
            }
        });
    }

    // Validate that a generated keypair is correct (matches Python implementation)
    async validateKeypair(privateKeyHex, publicKeyHex) {
        try {
            // Ensure library is loaded
            await this.initialize();
            
            // Convert hex strings back to Uint8Array
            const privateKeyBytes = new Uint8Array(
                privateKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
            );
            
            if (privateKeyBytes.length !== 64) {
                return { valid: false, error: 'Private key must be 64 bytes' };
            }
            
            // Extract the clamped scalar (first 32 bytes) - this is what MeshCore actually uses
            const clampedScalar = privateKeyBytes.slice(0, 32);
            
            // 1. Check that the private key is not all zeros
            if (clampedScalar.every(byte => byte === 0)) {
                return { valid: false, error: 'Private key cannot be all zeros' };
            }
            
            // 2. Validate Ed25519 scalar clamping rules (matches Python implementation)
            if ((clampedScalar[0] & 7) !== 0) {
                return { valid: false, error: 'Private key scalar not properly clamped (bits 0-2 should be 0)' };
            }
            
            if ((clampedScalar[31] & 192) !== 64) {
                return { valid: false, error: 'Private key scalar not properly clamped (bits 6 should be 1, bits 7 should be 0)' };
            }
            
            // 3. Check public key format
            const publicKeyBytes = new Uint8Array(
                publicKeyHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
            );
            
            if (publicKeyBytes.length !== 32) {
                return { valid: false, error: 'Public key must be 32 bytes' };
            }
            
            if (publicKeyBytes.every(byte => byte === 0)) {
                return { valid: false, error: 'Public key cannot be all zeros' };
            }
            
            // 4. CRITICAL: Verify that the private key actually generates the claimed public key
            try {
                // Use Point.BASE.multiply which accepts pre-clamped scalars (no double clamping)
                let derivedPublicKey;
                try {
                    // Convert scalar to BigInt for Point.BASE.multiply
                    let scalarBigInt = 0n;
                    for (let i = 0; i < 32; i++) {
                        scalarBigInt += BigInt(clampedScalar[i]) << BigInt(8 * i);
                    }
                    derivedPublicKey = nobleEd25519.Point.BASE.multiply(scalarBigInt);
                } catch (error) {
                    // Fallback to getPublicKey if Point.BASE.multiply fails
                    try {
                        derivedPublicKey = await nobleEd25519.getPublicKey(clampedScalar);
                    } catch (fallbackError) {
                        derivedPublicKey = nobleEd25519.getPublicKey(clampedScalar);
                    }
                }
                
                // Convert to Uint8Array if needed
                let derivedPublicKeyBytes;
                if (derivedPublicKey instanceof Uint8Array) {
                    derivedPublicKeyBytes = derivedPublicKey;
                } else if (derivedPublicKey.toRawBytes) {
                    derivedPublicKeyBytes = derivedPublicKey.toRawBytes();
                } else if (derivedPublicKey.toBytes) {
                    derivedPublicKeyBytes = derivedPublicKey.toBytes();
                } else if (derivedPublicKey.x !== undefined && derivedPublicKey.y !== undefined) {
                    // Point object with x, y coordinates
                    // Convert to compressed format (32 bytes)
                    derivedPublicKeyBytes = new Uint8Array(32);
                    const y = derivedPublicKey.y;
                    const x = derivedPublicKey.x;
                    
                    // Copy y-coordinate (little-endian)
                    for (let i = 0; i < 31; i++) {
                        derivedPublicKeyBytes[i] = Number((y >> BigInt(8 * i)) & 255n);
                    }
                    // Set the sign bit based on x-coordinate
                    derivedPublicKeyBytes[31] = Number((x & 1n) << 7);
                } else {
                    console.error('Unsupported derived public key format:', derivedPublicKey);
                    throw new Error(`Unsupported public key format from noble-ed25519: ${derivedPublicKey.constructor.name}`);
                }
                
                const derivedPublicHex = this.toHex(derivedPublicKeyBytes);
                
                if (derivedPublicHex !== publicKeyHex) {
                    return { 
                        valid: false, 
                        error: `Key verification failed: private key does not generate the claimed public key` 
                    };
                }
            } catch (error) {
                return { 
                    valid: false, 
                    error: `Key verification failed: ${error.message}` 
                };
            }
            
            return { valid: true };
        } catch (error) {
            return { valid: false, error: `Validation error: ${error.message}` };
        }
    }

    // Generate keys until we find a match
    async generateVanityKey(targetPrefix, prefixLength, progressCallback = null, difficultyCallback = null) {
        this.isRunning = true;
        this.stopRequested = false;
        this.attempts = 0;
        this.startTime = Date.now();
        this.lastUpdateTime = this.startTime;
        this.currentTargetPrefix = targetPrefix; // Store for difficulty estimate updates

        const updateProgress = () => {
            if (!this.isRunning) return;

            const now = Date.now();
            const elapsed = (now - this.startTime) / 1000;
            const rate = this.attempts / elapsed;

            // Estimate progress based on probability
            const probability = 1 / Math.pow(16, prefixLength);
            const expectedAttempts = 1 / probability;
            const progress = Math.min((this.attempts / expectedAttempts) * 100, 99);
            
            if (progressCallback) {
                const method = this.generationMode === 'js-fallback'
                    ? 'JS fallback'
                    : `${this.workers.length} WASM workers`;
                progressCallback({
                    attempts: this.attempts,
                    elapsed: elapsed,
                    rate: Math.round(rate),
                    progressPercentage: progress,
                    method: method,
                    perfStats: this.perfDebug ? this.getPerfSnapshot(elapsed) : null
                });
            }
        };

        // Update progress every 100ms
        this.updateInterval = setInterval(updateProgress, 100);
        
        // Update difficulty estimate every 10 seconds with current rate
        let lastDifficultyUpdate = 0;
        this.difficultyUpdateInterval = setInterval(() => {
            if (!this.isRunning) return;
            const elapsed = (Date.now() - this.startTime) / 1000;
            // Update every 10 seconds, starting after first 10 seconds
            if (elapsed - lastDifficultyUpdate >= 10 && elapsed >= 10) {
                const rate = this.attempts / elapsed;
                if (difficultyCallback) {
                    difficultyCallback(rate);
                }
                lastDifficultyUpdate = elapsed;
            }
        }, 10000); // Check every 10 seconds

        try {
            let matched = null;
            if (this.generationMode === 'js-fallback') {
                matched = await this.startJsFallbackSearch(targetPrefix);
            } else {
                try {
                    matched = await this.startWorkerSearch(targetPrefix);
                } catch (workerError) {
                    await this.loadJsFallback(`WASM search failed: ${workerError.message}`);
                    matched = await this.startJsFallbackSearch(targetPrefix);
                }
            }
            if (!matched) {
                return null;
            }

            const validation = await this.validateKeypair(matched.privateKey, matched.publicKey);
            if (!validation.valid) {
                throw new Error(`Key validation failed: ${validation.error}`);
            }

            this.isRunning = false;
            clearInterval(this.updateInterval);
            if (this.difficultyUpdateInterval) {
                clearInterval(this.difficultyUpdateInterval);
            }
            updateProgress();

            return {
                seed: matched.seed,
                publicKey: matched.publicKey,
                privateKey: matched.privateKey,
                attempts: this.attempts,
                timeElapsed: (Date.now() - this.startTime) / 1000,
                validation: validation
            };
        } catch (error) {
            this.isRunning = false;
            this.stopWorkers();
            clearInterval(this.updateInterval);
            if (this.difficultyUpdateInterval) {
                clearInterval(this.difficultyUpdateInterval);
            }
            throw error;
        }

        return null;
    }

    stop() {
        this.isRunning = false;
        this.stopRequested = true;
        if (this.generationMode === 'wasm') {
            this.stopWorkers();
        }
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
        }
        if (this.difficultyUpdateInterval) {
            clearInterval(this.difficultyUpdateInterval);
        }
        // Workers will continue running for reuse, no need to terminate
    }
}
