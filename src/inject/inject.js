/**
 * GARB Eye Tracking Extension - Content Script
 * Extracts content for consistent research data, renders in clean reader view
 */

(function() {
    // Flag to prevent multiple activations
    let isActivated = false;

    // Flag to track if extension context is valid
    let extensionContextValid = true;

    // Store original page HTML for extraction
    let originalPageHTML = null;
    let originalPageURL = null;

    // Word-by-word progressive highlighting state
    let wordReadProgress = {};

    // Reading progress tracking
    let totalWordsInArticle = 0;
    let wordsRead = 0;
    let autoScrollEnabled = false;

    // ========================================
    // TRACKING MODE CONTROL (Research Conditions)
    // ========================================
    // Mode A: 'gaze' - Eye tracker drives highlight (experimental condition)
    // Mode B: 'baseline' - Viewport center drives highlight (control condition)
    // Mode C: 'none' - No highlighting (baseline condition)
    const TRACKING_MODES = {
        GAZE: 'gaze',
        BASELINE: 'baseline',
        MANUAL: 'manual',
        NONE: 'none'
    };
    let currentTrackingMode = null; // Default to null - user must explicitly select a mode

    // ========================================
    // EYE TRACKER DEVICE SELECTION
    // ========================================
    // Supports: Consumer (Eye Tracker 5) and Pro (Pro Nano, etc.)
    let selectedDevice = null; // Device info from popup: { DeviceId, DeviceName, DeviceType, ... }
    let baselineUpdateInterval = null;
    const BASELINE_UPDATE_RATE_MS = 100; // Update baseline highlight every 100ms (smoother)

    // ========================================
    // PACE-BASED BASELINE MODE (WPM-driven)
    // ========================================
    let baselineWPM = 200; // Comfortable reading rate (reduced from 238 for smoother experience)
    let baselineWordIndex = 0; // Current global word position
    let baselineStartTime = 0; // When reading started
    let baselinePausedDuration = 0; // Total time spent paused
    let baselinePauseStartTime = 0; // When current pause started
    let baselineWordMap = []; // Flat array: [{line, wordIdx, element}, ...]
    let baselineTotalWords = 0;
    let baselineInitialized = false;

    // ========================================
    // MANUAL MODE STATE (arrow-key line-by-line)
    // ========================================
    let manualCurrentLine = 0;        // Index into manualLineElements
    let manualLineElements = [];      // Cached .garb-line elements in DOM order
    let manualModeActive = false;

    // ========================================
    // PAUSE/LOCK STATE
    // ========================================
    let isPaused = false;
    let pauseReason = null; // 'manual', 'tracking_lost'
    const TRACKING_LOST_THRESHOLD_MS = 500; // Unified threshold for pause + visual indicator

    // Stabilization for smooth tracking
    let lastStableLineNum = -1;
    let lastStableWordIdx = -1;
    let stabilityCounter = 0;
    const STABILITY_THRESHOLD = 4; // Gaze samples needed before changing position (increased)
    let lastScrollTime = 0;
    const SCROLL_COOLDOWN_GAZE = 1500; // ms between auto-scrolls for Mode A (increased for less jitter)
    const SCROLL_COOLDOWN_BASELINE = 1500; // ms between auto-scrolls for Mode B (increased for less jitter)
    let autoScrollInitialized = false; // Prevents auto-scroll during page load grace period

    // Research-based scroll parameters (based on Kumar & Winograd, Sharmin et al.)
    // Preferred Reading Zone: users read in comfortable middle region of viewport
    // Tuned for less responsive/jittery UX - only trigger when clearly at edges
    const SCROLL_ZONE_TOP = 0.18;     // Scroll up only when gaze near very top (18% from top)
    const SCROLL_ZONE_BOTTOM = 0.78;  // Scroll down only when gaze near very bottom (78% from top)
    const SCROLL_DWELL_TIME = 700;    // ms gaze must stay in trigger zone before scroll (longer = less sensitive)
    const SCROLL_DURATION_MS = 900;   // Duration for smooth scroll animation (slower = smoother)
    let scrollTriggerStartTime = 0;   // When gaze first entered scroll trigger zone (down)
    let scrollUpTriggerStartTime = 0; // When gaze first entered scroll trigger zone (up)

    // Current indicator stabilization (separate from reading progress)
    let displayedCurrentLine = -1;
    let displayedCurrentWord = -1;
    let lastIndicatorChangeTime = 0;
    const INDICATOR_MIN_DELAY = 150; // Minimum ms between indicator position changes

    // Floating gaze bubble - smooth animated circular spotlight with trail effect
    let gazeBubble = null;
    let gazeBubbleTrail = null; // Secondary bubble for trail effect
    let gazeBubbleTargetWord = null; // Store the target word element
    let gazeBubbleCurrent = { x: 0, y: 0 }; // Current position (top-left of bubble)
    let gazeBubbleTrailPos = { x: 0, y: 0 }; // Trail position (top-left of trail bubble)
    let gazeBubbleAnimationFrame = null;
    const GAZE_BUBBLE_LERP_SPEED = 0.06; // Main bubble speed (slower = smoother flow)
    const GAZE_BUBBLE_TRAIL_SPEED = 0.03; // Trail follows even slower for visual trail

    // ========================================
    // RESEARCH DATA LOGGING & ENHANCED GAZE PROCESSING
    // ========================================

    /**
     * Enhanced gaze state - centralized state management for all gaze tracking
     */
    const gazeState = {
        // EMA Smoothing
        ema: { x: null, y: null },
        emaAlpha: 0.3,

        // Velocity & Saccade Detection
        velocity: { x: 0, y: 0, magnitude: 0 },
        velocityHistory: [],
        saccadeThreshold: 800, // px/sec
        saccadeActive: false,
        saccadeFreezeStartTime: 0,
        saccadeFreezeMinDuration: 50, // ms

        // Confidence Tracking
        confidence: 1.0,
        confidenceHistory: [],
        lowConfidenceThreshold: 0.4,
        trackingLostThreshold: 0.2,
        trackingLost: false,
        lastValidGazeTime: 0,
        trackingLostDuration: 2000, // ms before showing "tracking lost"

        // Line Lock with Hysteresis
        candidateLine: -1,
        candidateLineStartTime: 0,
        candidateLineCount: 0,
        lineLockDurationMs: 300,
        lineMarginThreshold: 60, // px — must exceed eye tracker noise (~46px RMS)
        currentLockedLine: -1,

        // Manual nudge lock (prevents gaze override after nudge)
        nudgeLockUntil: 0,
        nudgeLockDuration: 800, // ms to lock after nudge

        // Raw sample history
        rawHistory: [],
        maxHistorySize: 15,
        maxHistoryAgeMs: 300,

        // Line geometry cache
        lineRects: [],
        lineRectsCacheTime: 0,
        lineRectsCacheDuration: 1000,

        // Resume marker
        lastStablePosition: { line: -1, word: -1 },

        // Tracking lost timer
        lastGazeReceivedTime: 0,
        trackingLostCheckInterval: null,
    };

    // ========================================
    // GAZE CALIBRATION (Multi-Monitor DPI Correction)
    // ========================================
    let gazeCalibration = null;       // Active: { scaleX, scaleY, fixedOffsetX, fixedOffsetY }
    let isCalibrating = false;
    let calibrationRawSamples = [];

    function getCalibrationStorageKey() {
        return `garb-gaze-cal-${screen.width}x${screen.height}-dpr${window.devicePixelRatio}-at${screen.availLeft},${screen.availTop}`;
    }

    /**
     * DataLogger - Comprehensive event logging for research
     */
    class DataLogger {
        constructor() {
            this.gazeEvents = [];
            this.uiEvents = [];
            this.sessionId = null;
            this.startTime = Date.now();

            // Fixation detection state
            this.currentFixation = null;
            this.fixationId = 0;
            this.lastGaze = null;
            this.lastTimestamp = 0;

            // Saccade amplitude tracking
            this.saccadeStartX = 0;
            this.saccadeStartY = 0;
            this.wasSaccade = false;

            // Data quality tracking
            this.expectedSamples = 0;       // Based on elapsed time × 60Hz
            this.actualSamples = 0;         // Samples actually received
            this.nominalSamplingRate = 60;  // Hz (Tobii Eye Tracker 5)

            // Precision tracking (RMS of gaze variance)
            this.gazeVarianceWindow = [];   // Last 10 samples for rolling precision
            this.gazeVarianceWindowSize = 10;
            this.precisionSumSquared = 0;
            this.precisionSampleCount = 0;

            // Blink detection (data gap method)
            this.lastSampleTime = 0;
            this.blinkCount = 0;            // Gaps 100-500ms = likely blink
            this.dataGapCount = 0;          // Gaps > 500ms = tracking loss

            // Summary metrics
            this.summary = {
                total_gaze_samples: 0,
                total_fixations: 0,
                fixation_durations: [],
                total_saccades: 0,
                saccade_speeds: [],
                saccade_amplitudes: [],     // Distance in pixels for each saccade
                total_lines_read: 0,
                total_words_read: 0,
                time_on_text_ms: 0,
                time_off_text_ms: 0,
                tracking_lost_count: 0,
                line_switch_count: 0,
                scroll_count: 0,
                manual_nudge_count: 0,
                // Regression tracking
                regression_count: 0,
                total_regression_lines: 0,
            };

            // Time tracking
            this.lastOnTextTime = null;
            this.isOnText = false;

            // Ring buffer for gaze events (limit memory usage)
            // Reduced to prevent 413 Payload Too Large errors
            this.maxGazeEvents = 5000; // ~83 seconds at 60Hz

            // Pro data tracking (pupil diameter, gaze origin)
            this.proDataEnabled = false;
            this.proDataSummary = {
                has_pupil_data: false,
                has_gaze_origin_data: false,
                pupil_samples: 0,
                avg_pupil_left_mm: 0,
                avg_pupil_right_mm: 0,
                pupil_left_sum: 0,
                pupil_right_sum: 0
            };
        }

        /**
         * Log a gaze event with fixation detection and data quality tracking
         * @param {number} x - Gaze X coordinate (viewport)
         * @param {number} y - Gaze Y coordinate (viewport)
         * @param {number} confidence - Gaze confidence (0-1)
         * @param {object} velocity - Velocity object { magnitude }
         * @param {object} proData - Optional Pro data { pupilLeftDiameter, pupilRightDiameter, gazeOrigin*, validity }
         */
        logGaze(x, y, confidence, velocity, proData = null) {
            const now = Date.now();
            this.summary.total_gaze_samples++;
            this.actualSamples++;

            // === Data Quality: Sample rate and data loss tracking ===
            const elapsedSeconds = (now - this.startTime) / 1000;
            this.expectedSamples = Math.floor(elapsedSeconds * this.nominalSamplingRate);

            // === Data Quality: Blink and gap detection via time gaps ===
            if (this.lastSampleTime > 0) {
                const gapMs = now - this.lastSampleTime;
                if (gapMs >= 100 && gapMs < 500) {
                    // Likely a blink (100-500ms gap)
                    this.blinkCount++;
                } else if (gapMs >= 500) {
                    // Significant data gap (tracking loss, not blink)
                    this.dataGapCount++;
                }
            }
            this.lastSampleTime = now;

            // === Data Quality: Precision (RMS of gaze variance) ===
            // Track variance within rolling window during fixations
            if (velocity.magnitude < 30) { // Only during fixations
                this.gazeVarianceWindow.push({ x, y });
                if (this.gazeVarianceWindow.length > this.gazeVarianceWindowSize) {
                    this.gazeVarianceWindow.shift();
                }

                // Calculate variance if we have enough samples
                if (this.gazeVarianceWindow.length >= 3) {
                    const meanX = this.gazeVarianceWindow.reduce((s, p) => s + p.x, 0) / this.gazeVarianceWindow.length;
                    const meanY = this.gazeVarianceWindow.reduce((s, p) => s + p.y, 0) / this.gazeVarianceWindow.length;

                    // Calculate squared error from mean (for RMS)
                    const sumSquaredError = this.gazeVarianceWindow.reduce((s, p) => {
                        return s + Math.pow(p.x - meanX, 2) + Math.pow(p.y - meanY, 2);
                    }, 0);

                    this.precisionSumSquared += sumSquaredError / this.gazeVarianceWindow.length;
                    this.precisionSampleCount++;
                }
            }

            // Build gaze event
            const event = {
                ts: now,
                gx: Math.round(x * 10) / 10,
                gy: Math.round(y * 10) / 10,
                conf: Math.round(confidence * 100) / 100,
            };

            // Add extended Pro data if available
            if (proData) {
                this.proDataEnabled = true;

                // Pupil diameter (mm)
                if (proData.pupilLeftDiameter !== null && !isNaN(proData.pupilLeftDiameter)) {
                    event.pupilL = Math.round(proData.pupilLeftDiameter * 100) / 100;
                    this.proDataSummary.has_pupil_data = true;
                    this.proDataSummary.pupil_left_sum += proData.pupilLeftDiameter;
                }
                if (proData.pupilRightDiameter !== null && !isNaN(proData.pupilRightDiameter)) {
                    event.pupilR = Math.round(proData.pupilRightDiameter * 100) / 100;
                    this.proDataSummary.pupil_right_sum += proData.pupilRightDiameter;
                }
                if (event.pupilL || event.pupilR) {
                    this.proDataSummary.pupil_samples++;
                }

                // Gaze origin (3D eye position in track box coordinates)
                if (proData.gazeOriginLeftZ !== null && !isNaN(proData.gazeOriginLeftZ)) {
                    event.originLZ = Math.round(proData.gazeOriginLeftZ * 1000) / 1000;
                    this.proDataSummary.has_gaze_origin_data = true;
                }
                if (proData.gazeOriginRightZ !== null && !isNaN(proData.gazeOriginRightZ)) {
                    event.originRZ = Math.round(proData.gazeOriginRightZ * 1000) / 1000;
                }

                // Validity flags
                if (proData.leftEyeValidity !== null) {
                    event.validL = proData.leftEyeValidity;
                }
                if (proData.rightEyeValidity !== null) {
                    event.validR = proData.rightEyeValidity;
                }
            }

            // Fixation detection (I-VT algorithm)
            const FIXATION_VELOCITY_THRESHOLD = 30; // px/sample
            const FIXATION_MIN_DURATION_MS = 100;

            const isSaccade = velocity.magnitude >= FIXATION_VELOCITY_THRESHOLD;

            if (!isSaccade) {
                // Within fixation
                if (!this.currentFixation) {
                    this.fixationId++;
                    this.currentFixation = {
                        id: this.fixationId,
                        startTime: now,
                    };
                }

                const duration = now - this.currentFixation.startTime;
                if (duration >= FIXATION_MIN_DURATION_MS) {
                    event.fix_id = this.currentFixation.id;
                    event.fix_dur = duration;
                }

                // Track saccade end (transition from saccade to fixation)
                if (this.wasSaccade) {
                    // Saccade just ended - calculate amplitude
                    const saccadeAmplitude = Math.sqrt(
                        Math.pow(x - this.saccadeStartX, 2) +
                        Math.pow(y - this.saccadeStartY, 2)
                    );
                    this.summary.saccade_amplitudes.push(Math.round(saccadeAmplitude));
                    event.sac_amp = Math.round(saccadeAmplitude);
                }
            } else {
                // Saccade detected
                // Track saccade start position
                if (!this.wasSaccade) {
                    this.saccadeStartX = this.lastGaze ? this.lastGaze.x : x;
                    this.saccadeStartY = this.lastGaze ? this.lastGaze.y : y;
                }

                if (this.currentFixation) {
                    const duration = now - this.currentFixation.startTime;
                    if (duration >= FIXATION_MIN_DURATION_MS) {
                        this.summary.total_fixations++;
                        this.summary.fixation_durations.push(duration);
                    }
                    this.summary.total_saccades++;
                    this.summary.saccade_speeds.push(velocity.magnitude);
                    event.sac_spd = Math.round(velocity.magnitude);
                }
                this.currentFixation = null;
            }

            // Track state for next iteration
            this.wasSaccade = isSaccade;
            this.lastGaze = { x, y };

            // Add to buffer (ring buffer behavior)
            this.gazeEvents.push(event);
            if (this.gazeEvents.length > this.maxGazeEvents) {
                this.gazeEvents.shift();
            }
        }

        /**
         * Log a UI event
         */
        logUIEvent(type, data = {}) {
            const event = {
                ts: Date.now(),
                type: type,
                ...data
            };
            this.uiEvents.push(event);

            // Update summary metrics
            switch (type) {
                case 'line_switch':
                    this.summary.line_switch_count++;
                    break;
                case 'tracking_lost':
                    this.summary.tracking_lost_count++;
                    break;
                case 'scroll':
                    this.summary.scroll_count++;
                    break;
                case 'manual_nudge':
                    this.summary.manual_nudge_count++;
                    break;
                case 'regression':
                    this.summary.regression_count++;
                    if (data.lines_back) {
                        this.summary.total_regression_lines += data.lines_back;
                    }
                    break;
            }
        }

        /**
         * Update time on/off text tracking
         */
        updateTextPresence(isOnText) {
            const now = Date.now();

            if (this.lastOnTextTime === null) {
                this.lastOnTextTime = now;
                this.isOnText = isOnText;
                return;
            }

            const elapsed = now - this.lastOnTextTime;

            if (this.isOnText) {
                this.summary.time_on_text_ms += elapsed;
            } else {
                this.summary.time_off_text_ms += elapsed;
            }

            this.lastOnTextTime = now;
            this.isOnText = isOnText;
        }

        /**
         * Convert gaze events to JSONL format
         * Uses compact format to reduce payload size
         */
        gazeToJSONL() {
            // Use compact CSV-style format: ts,gx,gy,conf[,fix_id,fix_dur][,sac_spd,sac_amp]
            // Header line indicates format version
            const header = 'v2:ts,gx,gy,conf,fix_id,fix_dur,sac_spd,sac_amp';
            const lines = this.gazeEvents.map(e => {
                // Use relative timestamp (ms from session start) to save bytes
                const relTs = e.ts - this.startTime;
                return `${relTs},${e.gx},${e.gy},${e.conf},${e.fix_id||''},${e.fix_dur||''},${e.sac_spd||''},${e.sac_amp||''}`;
            });
            return header + '\n' + lines.join('\n');
        }

        /**
         * Convert gaze events to JSONL format (legacy full format)
         */
        gazeToJSONLFull() {
            return this.gazeEvents.map(e => JSON.stringify(e)).join('\n');
        }

        /**
         * Convert UI events to JSONL format
         */
        uiToJSONL() {
            return this.uiEvents.map(e => JSON.stringify(e)).join('\n');
        }

        /**
         * Estimate payload size and return size-safe data
         * If data is too large, sample it down
         */
        getSizeSafeGazeData(maxSizeBytes = 500000) {
            let data = this.gazeToJSONL();

            // If within limit, return as-is
            if (data.length <= maxSizeBytes) {
                return { data, sampled: false, originalCount: this.gazeEvents.length };
            }

            // Data too large - sample every Nth event
            const samplingRatio = Math.ceil(data.length / maxSizeBytes);
            const sampledEvents = this.gazeEvents.filter((_, i) => i % samplingRatio === 0);

            const header = `v2:ts,gx,gy,conf,fix_id,fix_dur,sac_spd,sac_amp (sampled 1:${samplingRatio})`;
            const lines = sampledEvents.map(e => {
                const relTs = e.ts - this.startTime;
                return `${relTs},${e.gx},${e.gy},${e.conf},${e.fix_id||''},${e.fix_dur||''},${e.sac_spd||''},${e.sac_amp||''}`;
            });

            console.log(`GARB: Gaze data sampled 1:${samplingRatio} (${this.gazeEvents.length} -> ${sampledEvents.length} events)`);

            return {
                data: header + '\n' + lines.join('\n'),
                sampled: true,
                samplingRatio,
                originalCount: this.gazeEvents.length,
                sampledCount: sampledEvents.length
            };
        }

        /**
         * Get computed summary metrics including data quality
         */
        getSummary() {
            const sessionDuration = Date.now() - this.startTime;
            const fixDurations = this.summary.fixation_durations;
            const sacSpeeds = this.summary.saccade_speeds;
            const sacAmplitudes = this.summary.saccade_amplitudes;

            // Calculate data loss ratio
            const dataLossRatio = this.expectedSamples > 0
                ? Math.round((1 - (this.actualSamples / this.expectedSamples)) * 1000) / 1000
                : 0;

            // Calculate precision RMS (root mean square of gaze variance)
            const precisionRMS = this.precisionSampleCount > 0
                ? Math.round(Math.sqrt(this.precisionSumSquared / this.precisionSampleCount) * 10) / 10
                : 0;

            // Calculate actual sampling rate achieved
            const sessionSeconds = sessionDuration / 1000;
            const actualSamplingRate = sessionSeconds > 0
                ? Math.round((this.actualSamples / sessionSeconds) * 10) / 10
                : 0;

            // Calculate average regression distance
            const avgRegressionDistance = this.summary.regression_count > 0
                ? Math.round((this.summary.total_regression_lines / this.summary.regression_count) * 10) / 10
                : 0;

            return {
                // Core metrics
                total_gaze_samples: this.summary.total_gaze_samples,
                total_fixations: this.summary.total_fixations,
                avg_fixation_duration_ms: fixDurations.length > 0
                    ? Math.round(fixDurations.reduce((a, b) => a + b, 0) / fixDurations.length)
                    : 0,
                total_saccades: this.summary.total_saccades,
                avg_saccade_speed: sacSpeeds.length > 0
                    ? Math.round(sacSpeeds.reduce((a, b) => a + b, 0) / sacSpeeds.length)
                    : 0,
                avg_saccade_amplitude_px: sacAmplitudes.length > 0
                    ? Math.round(sacAmplitudes.reduce((a, b) => a + b, 0) / sacAmplitudes.length)
                    : 0,

                // Reading metrics
                total_lines_read: this.summary.total_lines_read,
                total_words_read: this.summary.total_words_read,
                reading_speed_wpm: sessionDuration > 0
                    ? Math.round((this.summary.total_words_read / sessionDuration) * 60000)
                    : 0,
                time_on_text_ms: this.summary.time_on_text_ms,
                time_off_text_ms: this.summary.time_off_text_ms,

                // Event counts
                tracking_lost_count: this.summary.tracking_lost_count,
                line_switch_count: this.summary.line_switch_count,
                scroll_count: this.summary.scroll_count,
                manual_nudge_count: this.summary.manual_nudge_count,

                // Data quality metrics (for research paper)
                data_quality: {
                    data_loss_ratio: Math.max(0, dataLossRatio), // Clamp to >= 0
                    precision_rms_px: precisionRMS,
                    blink_count: this.blinkCount,
                    data_gap_count: this.dataGapCount,
                    sampling_rate_nominal_hz: this.nominalSamplingRate,
                    sampling_rate_actual_hz: actualSamplingRate,
                    expected_samples: this.expectedSamples,
                    actual_samples: this.actualSamples,
                },

                // Regression metrics
                regressions: {
                    count: this.summary.regression_count,
                    total_lines: this.summary.total_regression_lines,
                    avg_distance: avgRegressionDistance,
                },
            };
        }

        /**
         * Get settings snapshot
         */
        getSettingsSnapshot() {
            return {
                sensitivity: STABILITY_THRESHOLD,
                lock_time_ms: gazeState.lineLockDurationMs,
                highlight_opacity: 0.25, // TODO: make configurable
                auto_scroll: autoScrollEnabled,
                theme: localStorage.getItem('garb-theme') || 'gray',
                font: localStorage.getItem('garb-font') || 'serif',
                font_size: localStorage.getItem('garb-size') || 'medium',
                gaze_y_offset: GAZE_Y_OFFSET,
                gaze_x_offset: GAZE_X_OFFSET,
            };
        }

        /**
         * Get device and environment metadata for research paper reporting
         */
        getDeviceMetadata() {
            // Calculate average pupil diameter if Pro data available
            let avgPupilLeft = null;
            let avgPupilRight = null;
            if (this.proDataSummary.pupil_samples > 0) {
                avgPupilLeft = Math.round((this.proDataSummary.pupil_left_sum / this.proDataSummary.pupil_samples) * 100) / 100;
                avgPupilRight = Math.round((this.proDataSummary.pupil_right_sum / this.proDataSummary.pupil_samples) * 100) / 100;
            }

            return {
                // Screen info
                screen_width: window.screen.width,
                screen_height: window.screen.height,
                screen_color_depth: window.screen.colorDepth,
                device_pixel_ratio: window.devicePixelRatio,

                // Viewport info
                viewport_width: window.innerWidth,
                viewport_height: window.innerHeight,

                // Browser info
                user_agent: navigator.userAgent,
                platform: navigator.platform,

                // Eye tracker info (dynamic based on selected device)
                eye_tracker_model: selectedDevice ? selectedDevice.DeviceName : "Tobii Eye Tracker 5",
                eye_tracker_type: selectedDevice ? selectedDevice.DeviceType : "Consumer",
                eye_tracker_device_id: selectedDevice ? selectedDevice.DeviceId : null,
                nominal_sampling_rate: selectedDevice && selectedDevice.SamplingRate ? selectedDevice.SamplingRate : 60,

                // Pro data availability
                supports_pupil_data: selectedDevice ? selectedDevice.SupportsPupilData : false,
                supports_gaze_origin: selectedDevice ? selectedDevice.SupportsGazeOrigin : false,
                pro_data_enabled: this.proDataEnabled,

                // Pro data summary (if available)
                avg_pupil_left_mm: avgPupilLeft,
                avg_pupil_right_mm: avgPupilRight,
                has_gaze_origin_data: this.proDataSummary.has_gaze_origin_data,

                // Calibration (Tobii native calibration)
                calibration_method: selectedDevice && selectedDevice.DeviceType === 'Pro'
                    ? "Tobii Pro Eye Tracker Manager"
                    : "Tobii Experience 9-point",
            };
        }

        /**
         * Get processing method documentation for research paper
         */
        getProcessingMethods() {
            return {
                smoothing: "EMA (alpha=0.3, adaptive based on velocity)",
                fixation_detection: "I-VT (velocity threshold 30px/sample, min duration 100ms)",
                saccade_detection: "Velocity threshold (800px/sec, 50ms freeze period)",
                line_lock: "Hysteresis (time=" + gazeState.lineLockDurationMs + "ms, margin=" + gazeState.lineMarginThreshold + "px)",
                aoi_definition: "DOM line bounding boxes from .garb-line elements",
                confidence_calculation: "Velocity + spatial consistency based (0-1 scale)",
                tracking_lost_threshold: gazeState.trackingLostDuration + "ms without valid gaze on text",
                blink_detection: "Data gaps 100-500ms classified as blinks",
            };
        }
    }

    // Global data logger instance
    let dataLogger = null;

    /**
     * Initialize data logger for a session
     */
    function initDataLogger() {
        dataLogger = new DataLogger();
        dataLogger.startTime = Date.now();
        console.log("GARB DataLogger initialized");
    }

    // Helper function to safely send messages to the extension
    function safeSendMessage(message, callback) {
        if (!extensionContextValid) {
            console.log("Extension context invalidated, cannot send message");
            return;
        }

        try {
            chrome.runtime.sendMessage(message, response => {
                if (chrome.runtime.lastError) {
                    const errorMessage = chrome.runtime.lastError.message || '';
                    if (errorMessage.includes('Extension context invalidated')) {
                        extensionContextValid = false;
                        console.log("Extension was reloaded. Please refresh the page.");
                        showStatusIndicator("Extension reloaded - refresh page", true);
                    } else {
                        console.log("Runtime error:", errorMessage);
                    }
                    return;
                }
                if (callback) callback(response);
            });
        } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
                extensionContextValid = false;
                console.log("Extension was reloaded. Please refresh the page.");
                showStatusIndicator("Extension reloaded - refresh page", true);
            } else {
                console.error("Error sending message:", error);
            }
        }
    }

    // Status indicator element reference
    let statusIndicator = null;

    // Listen for activation/deactivation messages
    try {
        chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
            try {
                if (request.action === "activate" && !isActivated) {
                    console.log("GARB: Activating eye tracking...");

                    // Store original page for extraction
                    originalPageHTML = document.documentElement.outerHTML;
                    originalPageURL = location.href;

                    isActivated = true;

                    // Capture selected device from activation message
                    if (request.device) {
                        selectedDevice = request.device;
                        console.log("GARB: Using device:", selectedDevice.DeviceName, "(", selectedDevice.DeviceType, ")");
                    } else {
                        // Default to consumer for backward compatibility
                        selectedDevice = { DeviceId: 'tobii-consumer', DeviceName: 'Tobii Eye Tracker 5', DeviceType: 'Consumer' };
                        console.log("GARB: No device specified, defaulting to Consumer");
                    }

                    // Use mode from activation message if provided
                    // Check for explicit mode value (including null which means "no mode selected")
                    if ('mode' in request) {
                        const mode = request.mode;
                        if (mode === TRACKING_MODES.GAZE ||
                            mode === TRACKING_MODES.BASELINE ||
                            mode === TRACKING_MODES.NONE) {
                            currentTrackingMode = mode;
                            console.log("GARB: Starting with mode from activation:", mode);
                        } else {
                            // Mode is null or invalid - user must select a mode
                            currentTrackingMode = null;
                            console.log("GARB: Starting with no mode selected - user must choose");
                        }
                        runInjection();
                    } else {
                        // No mode in request - start with no mode (user must select)
                        currentTrackingMode = null;
                        console.log("GARB: No mode provided - user must select a mode");
                        runInjection();
                    }
                    sendResponse({ success: true });
                }

                if (request.action === "deactivate" && isActivated) {
                    console.log("GARB: Deactivating eye tracking...");
                    deactivateTracking();
                    sendResponse({ success: true });
                }

                if (request.action === "getStatus") {
                    sendResponse({ isActivated: isActivated });
                }

                // Handle mode switching (3 modes: gaze, baseline, none)
                if (request.switchMode && isActivated) {
                    console.log("Mode switched to:", request.switchMode);
                    window.eyeTrackingViewMode = request.switchMode;

                    // Accept both string modes and numeric modes for backwards compatibility
                    let mode = request.switchMode;

                    // If string mode, validate it
                    if (typeof mode === 'string') {
                        if (mode === TRACKING_MODES.GAZE ||
                            mode === TRACKING_MODES.BASELINE ||
                            mode === TRACKING_MODES.NONE) {
                            // Valid string mode, use as-is
                        } else if (mode === '1') {
                            mode = TRACKING_MODES.GAZE;
                        } else if (mode === '2') {
                            mode = TRACKING_MODES.BASELINE;
                        } else if (mode === '3') {
                            mode = TRACKING_MODES.NONE;
                        } else {
                            // Unknown mode, default to gaze
                            console.warn("Unknown mode:", mode, "defaulting to gaze");
                            mode = TRACKING_MODES.GAZE;
                        }
                    } else if (typeof mode === 'number') {
                        // Numeric mode mapping: 1 = gaze, 2 = baseline, 3 = none
                        if (mode === 1) mode = TRACKING_MODES.GAZE;
                        else if (mode === 2) mode = TRACKING_MODES.BASELINE;
                        else if (mode === 3) mode = TRACKING_MODES.NONE;
                        else mode = TRACKING_MODES.GAZE;
                    }

                    setTrackingMode(mode);
                    sendResponse({ success: true, mode: mode });
                }

                // Handle settings changes
                if (request.action === "settingsChanged" && isActivated) {
                    loadSettings();
                    sendResponse({ success: true });
                }
            } catch (error) {
                if (error.message && error.message.includes('Extension context invalidated')) {
                    extensionContextValid = false;
                } else {
                    console.error("Error in message listener:", error);
                }
            }

            return true;
        });
    } catch (error) {
        console.log("Could not add message listener - extension context may be invalid");
        extensionContextValid = false;
    }

    /**
     * Deactivate tracking and restore original page with exit animation
     */
    function deactivateTracking() {
        // Close WebSocket
        if (window.eyeTrackingWebSocket) {
            window.eyeTrackingWebSocket.close();
            window.eyeTrackingWebSocket = null;
        }

        isActivated = false;

        // Stop baseline mode interval if running
        if (baselineUpdateInterval) {
            clearInterval(baselineUpdateInterval);
            baselineUpdateInterval = null;
        }

        // Reset tracking mode to none (user must select again)
        currentTrackingMode = TRACKING_MODES.NONE;

        // Reset pause state
        isPaused = false;
        pauseReason = null;

        // Stop gaze bubble animation and clean up
        if (gazeBubbleAnimationFrame) {
            cancelAnimationFrame(gazeBubbleAnimationFrame);
            gazeBubbleAnimationFrame = null;
        }
        if (gazeBubble) {
            gazeBubble.remove();
            gazeBubble = null;
        }
        if (gazeBubbleTrail) {
            gazeBubbleTrail.remove();
            gazeBubbleTrail = null;
        }

        // Trigger exit animation
        const body = document.body;
        if (body && body.classList.contains('garb-reader')) {
            body.classList.remove('garb-animate-in');
            body.classList.add('garb-animate-out');

            // Wait for animation to complete before navigating
            setTimeout(() => {
                // Remove status indicator
                if (statusIndicator) {
                    statusIndicator.remove();
                    statusIndicator = null;
                }

                // Navigate back to original URL
                if (originalPageURL) {
                    location.href = originalPageURL;
                } else {
                    location.reload();
                }
            }, 300); // Match animation duration
        } else {
            // No animation possible, just navigate
            if (statusIndicator) {
                statusIndicator.remove();
                statusIndicator = null;
            }
            if (originalPageURL) {
                location.href = originalPageURL;
            } else {
                location.reload();
            }
        }
    }

    /**
     * Create and show the tracking status indicator with integrated settings
     */
    function showStatusIndicator(text, isError = false) {
        if (statusIndicator) {
            statusIndicator.remove();
        }

        statusIndicator = document.createElement('div');
        statusIndicator.className = 'garb-status' + (isError ? ' error' : '');
        statusIndicator.innerHTML = `
            <span class="garb-status-dot"></span>
            <span class="garb-status-text">${text}</span>
            <button class="garb-settings-toggle" id="garb-settings-toggle" title="Reader Settings"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg></button>
            <button class="garb-deactivate-btn" title="Stop tracking">✕</button>
        `;
        document.body.appendChild(statusIndicator);

        // Add deactivate button handler
        const deactivateBtn = statusIndicator.querySelector('.garb-deactivate-btn');
        if (deactivateBtn) {
            deactivateBtn.addEventListener('click', deactivateTracking);
        }

        // Add settings toggle handler
        const settingsToggle = statusIndicator.querySelector('.garb-settings-toggle');
        const settingsPanel = document.getElementById('garb-settings-panel');
        if (settingsToggle && settingsPanel) {
            settingsToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                settingsPanel.classList.toggle('visible');
                settingsToggle.classList.toggle('active');
            });
        }
    }

    /**
     * Update the status indicator text
     */
    function updateStatusIndicator(text, isError = false) {
        if (statusIndicator) {
            const textEl = statusIndicator.querySelector('.garb-status-text');
            if (textEl) textEl.textContent = text;
            statusIndicator.className = 'garb-status' + (isError ? ' error' : '');
        }
    }

    /**
     * Escape HTML special characters
     */
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Parse text with link markers [[text|url]] into word objects
     */
    function parseTextWithLinks(text) {
        if (!text) return [];

        const words = [];
        // Match link markers or regular words
        // Link format: [[link text|url]]
        const linkPattern = /\[\[([^\]|]+)\|([^\]]+)\]\]/g;

        let lastIndex = 0;
        let match;

        while ((match = linkPattern.exec(text)) !== null) {
            // Add words before the link
            const beforeText = text.slice(lastIndex, match.index);
            const beforeWords = beforeText.split(/\s+/).filter(w => w.length > 0);
            beforeWords.forEach(w => words.push({ text: w, link: null }));

            // Add link words
            const linkText = match[1];
            const linkUrl = match[2];
            const linkWords = linkText.split(/\s+/).filter(w => w.length > 0);
            linkWords.forEach(w => words.push({ text: w, link: linkUrl }));

            lastIndex = match.index + match[0].length;
        }

        // Add remaining words after last link
        const afterText = text.slice(lastIndex);
        const afterWords = afterText.split(/\s+/).filter(w => w.length > 0);
        afterWords.forEach(w => words.push({ text: w, link: null }));

        return words;
    }

    /**
     * Convert text to trackable lines with individual words
     * Uses fixed character width for consistent line mapping
     * Supports link markers [[text|url]] for hyperlinks
     */
    function textToTrackableLines(textOrHtml, startLineNum, useHtml = false) {
        const text = useHtml ? textOrHtml : textOrHtml;
        if (!text || text.trim().length === 0) return { html: '', lineCount: 0 };

        const CHARS_PER_LINE = 85; // Slightly wider for better use of space
        const wordObjects = parseTextWithLinks(text);

        if (wordObjects.length === 0) return { html: '', lineCount: 0 };

        // Split into lines based on character count
        let lines = [];
        let currentLineWords = [];
        let currentLineLength = 0;

        for (const wordObj of wordObjects) {
            const wordLength = wordObj.text.length;
            const spaceNeeded = currentLineWords.length > 0 ? 1 : 0;

            if (currentLineLength + spaceNeeded + wordLength <= CHARS_PER_LINE) {
                currentLineWords.push(wordObj);
                currentLineLength += spaceNeeded + wordLength;
            } else {
                if (currentLineWords.length > 0) {
                    lines.push(currentLineWords);
                }
                currentLineWords = [wordObj];
                currentLineLength = wordLength;
            }
        }
        if (currentLineWords.length > 0) {
            lines.push(currentLineWords);
        }

        // Convert lines to HTML with individual word spans and links
        let html = '';
        let lineNum = startLineNum;

        for (const lineWords of lines) {
            let wordSpans = [];
            let currentLink = null;
            let linkWords = [];

            const flushLink = () => {
                if (linkWords.length > 0 && currentLink) {
                    const linkHtml = `<a href="${escapeHtml(currentLink)}" target="_blank" rel="noopener">${linkWords.join(' ')}</a>`;
                    wordSpans.push(linkHtml);
                    linkWords = [];
                }
            };

            lineWords.forEach((wordObj, wordIdx) => {
                const wordSpan = `<span class="garb-word" data-word="${wordIdx}" data-line="${lineNum}">${escapeHtml(wordObj.text)}</span>`;

                if (wordObj.link) {
                    if (currentLink === wordObj.link) {
                        // Continue same link
                        linkWords.push(wordSpan);
                    } else {
                        // New link - flush previous if any
                        flushLink();
                        currentLink = wordObj.link;
                        linkWords.push(wordSpan);
                    }
                } else {
                    // Not a link - flush any pending link
                    flushLink();
                    currentLink = null;
                    wordSpans.push(wordSpan);
                }
            });

            // Flush any remaining link
            flushLink();

            html += `<span class="garb-line" data-line="${lineNum}" data-word-count="${lineWords.length}">${wordSpans.join(' ')}</span>\n`;
            lineNum++;
        }

        return { html, lineCount: lines.length };
    }

    /**
     * Build formatted content from structured data
     */
    function buildFormattedContent(formattedContent) {
        let html = '';
        let lineNum = 0;

        for (const block of formattedContent) {
            switch (block.type) {
                case 'heading':
                    const headingLevel = Math.min(Math.max(block.level || 2, 2), 6);
                    const headingResult = textToTrackableLines(block.text, lineNum);
                    html += `<h${headingLevel} class="garb-heading garb-h${headingLevel}">${headingResult.html}</h${headingLevel}>`;
                    lineNum += headingResult.lineCount;
                    break;

                case 'paragraph':
                    // Use html field with links if available, otherwise fall back to text
                    const paraText = block.html || block.text;
                    const paraResult = textToTrackableLines(paraText, lineNum, !!block.html);
                    html += `<p class="garb-paragraph">${paraResult.html}</p>`;
                    lineNum += paraResult.lineCount;
                    break;

                case 'quote':
                    const quoteResult = textToTrackableLines(block.text, lineNum);
                    html += `<blockquote class="garb-quote">${quoteResult.html}</blockquote>`;
                    lineNum += quoteResult.lineCount;
                    break;

                case 'list':
                    const listTag = block.ordered ? 'ol' : 'ul';
                    let listItems = '';
                    for (const item of (block.items || [])) {
                        const itemResult = textToTrackableLines(item, lineNum);
                        listItems += `<li class="garb-list-item">${itemResult.html}</li>`;
                        lineNum += itemResult.lineCount;
                    }
                    html += `<${listTag} class="garb-list">${listItems}</${listTag}>`;
                    break;

                case 'image':
                    if (block.src) {
                        html += `<figure class="garb-figure">
                            <img class="garb-inline-image" src="${escapeHtml(block.src)}" alt="${escapeHtml(block.alt || '')}">
                            ${block.caption ? `<figcaption class="garb-caption">${escapeHtml(block.caption)}</figcaption>` : ''}
                        </figure>`;
                    }
                    break;
            }
        }

        window.garbTotalLines = lineNum;
        return html;
    }

    /**
     * Build content from plain text (fallback)
     */
    function buildPlainTextContent(rawContentStr) {
        if (!rawContentStr) return { html: '', lineCount: 0 };

        const paragraphs = rawContentStr.split(/\n\n+/).filter(p => p.trim().length > 0);
        let html = '';
        let totalLines = 0;

        for (const para of paragraphs) {
            const result = textToTrackableLines(para.trim(), totalLines);
            html += `<p class="garb-paragraph">${result.html}</p>`;
            totalLines += result.lineCount;
        }

        window.garbTotalLines = totalLines;
        return { html, lineCount: totalLines };
    }

    /**
     * Count lines in content
     */
    function countLines() {
        return window.garbTotalLines || 0;
    }

    /**
     * Initialize settings toolbar functionality
     */
    function initializeSettings() {
        const SIZE_CLASSES = ['size-xs', 'size-small', 'size-medium'];
        const panel = document.getElementById('garb-settings-panel');

        // Close panel when clicking anywhere outside (use window + capture for full coverage)
        if (panel) {
            window.addEventListener('click', (e) => {
                const toggleBtn = document.getElementById('garb-settings-toggle');
                if (!panel.contains(e.target) && e.target !== toggleBtn && !e.target.closest('.garb-settings-toggle')) {
                    panel.classList.remove('visible');
                    if (toggleBtn) toggleBtn.classList.remove('active');
                }
            }, true); // Use capture phase to catch all clicks

            // Also close on Escape key
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && panel.classList.contains('visible')) {
                    panel.classList.remove('visible');
                    const toggleBtn = document.getElementById('garb-settings-toggle');
                    if (toggleBtn) toggleBtn.classList.remove('active');
                }
            });
        }

        // Theme buttons
        document.querySelectorAll('.garb-theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.dataset.theme;
                const body = document.body;

                // Remove all theme classes
                body.classList.remove('theme-white', 'theme-gray', 'theme-cream', 'theme-dark');
                body.classList.add(`theme-${theme}`);

                // Update active state
                document.querySelectorAll('.garb-theme-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Save preference
                try {
                    localStorage.setItem('garb-theme', theme);
                } catch (e) {}
            });
        });

        // Font buttons
        document.querySelectorAll('.garb-font-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const font = btn.dataset.font;
                const body = document.body;

                // Remove all font classes
                body.classList.remove('font-system', 'font-serif', 'font-sans', 'font-sf', 'font-dyslexic');
                body.classList.add(`font-${font}`);

                // Update active state
                document.querySelectorAll('.garb-font-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Save preference
                try {
                    localStorage.setItem('garb-font', font);
                } catch (e) {}
            });
        });

        // Size buttons
        document.querySelectorAll('.garb-size-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const size = btn.dataset.size;
                const body = document.body;

                // Remove all size classes
                SIZE_CLASSES.forEach(c => body.classList.remove(c));
                body.classList.add(`size-${size}`);

                // Update active state
                document.querySelectorAll('.garb-size-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Save preference
                try {
                    localStorage.setItem('garb-size', size);
                } catch (e) {}
            });
        });

        // Mode buttons (in-page mode switching)
        document.querySelectorAll('.garb-mode-btn-compact').forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                console.log("GARB: In-page mode button clicked:", mode);

                // Update UI immediately
                document.querySelectorAll('.garb-mode-btn-compact').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Call setTrackingMode directly (immediate effect)
                setTrackingMode(mode);

                // Save to storage for persistence
                try {
                    chrome.storage.local.set({ trackingMode: mode });
                } catch (e) {
                    console.log("Could not save mode to storage:", e);
                }
            });
        });

        // Auto-scroll toggle
        const autoscrollCheckbox = document.getElementById('garb-autoscroll-checkbox');
        if (autoscrollCheckbox) {
            autoscrollCheckbox.addEventListener('change', function() {
                autoScrollEnabled = this.checked;
                try {
                    localStorage.setItem('garb-autoscroll', autoScrollEnabled ? 'true' : 'false');
                } catch (e) {}
                // Show visual feedback
                showAutoScrollFeedback(autoScrollEnabled);
            });
        }

        // Gaze calibration buttons
        const calibrateBtn = document.getElementById('garb-calibrate-btn');
        if (calibrateBtn) {
            calibrateBtn.addEventListener('click', () => {
                const panel = document.getElementById('garb-settings-panel');
                if (panel) panel.classList.remove('visible');
                setTimeout(() => startGazeCalibration(), 200);
            });
        }
        const calibrateClearBtn = document.getElementById('garb-calibrate-clear');
        if (calibrateClearBtn) {
            calibrateClearBtn.addEventListener('click', () => {
                gazeCalibration = null;
                try { localStorage.removeItem(getCalibrationStorageKey()); } catch (e) {}
                updateCalibrationBadge();
                console.log('[GARB] Calibration cleared, using fallback');
            });
        }

        // Load saved gaze calibration for this monitor
        try {
            const saved = localStorage.getItem(getCalibrationStorageKey());
            if (saved) {
                gazeCalibration = JSON.parse(saved);
                console.log('[GARB] Loaded saved calibration:', gazeCalibration);
            }
        } catch (e) {}
        updateCalibrationBadge();

        // Clear progress button
        const clearProgressBtn = document.getElementById('garb-clear-progress');
        if (clearProgressBtn) {
            clearProgressBtn.addEventListener('click', () => {
                clearReadingProgress();
            });
        }

        // Zoom slider
        const zoomSlider = document.getElementById('garb-zoom-slider');
        const zoomValue = document.getElementById('garb-zoom-value');
        const zoomReset = document.getElementById('garb-zoom-reset');

        if (zoomSlider) {
            zoomSlider.addEventListener('input', function() {
                const zoom = this.value;
                document.body.dataset.zoom = zoom;
                if (zoomValue) zoomValue.textContent = `${zoom}%`;
                try {
                    localStorage.setItem('garb-zoom', zoom);
                } catch (e) {}
            });
        }

        if (zoomReset) {
            zoomReset.addEventListener('click', function() {
                if (zoomSlider) {
                    zoomSlider.value = 100;
                    document.body.dataset.zoom = '100';
                    if (zoomValue) zoomValue.textContent = '100%';
                    try {
                        localStorage.setItem('garb-zoom', '100');
                    } catch (e) {}
                }
            });
        }

        // Load saved preferences
        try {
            const savedTheme = localStorage.getItem('garb-theme');
            const savedFont = localStorage.getItem('garb-font');
            const savedSize = localStorage.getItem('garb-size');
            const savedAutoscroll = localStorage.getItem('garb-autoscroll');

            if (savedTheme) {
                document.body.classList.remove('theme-white', 'theme-gray', 'theme-cream', 'theme-dark');
                document.body.classList.add(`theme-${savedTheme}`);
                document.querySelectorAll('.garb-theme-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.theme === savedTheme);
                });
            }

            if (savedFont) {
                document.body.classList.remove('font-system', 'font-serif', 'font-sans', 'font-sf', 'font-dyslexic');
                document.body.classList.add(`font-${savedFont}`);
                document.querySelectorAll('.garb-font-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.font === savedFont);
                });
            }

            if (savedSize) {
                SIZE_CLASSES.forEach(c => document.body.classList.remove(c));
                document.body.classList.add(`size-${savedSize}`);
                document.querySelectorAll('.garb-size-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.size === savedSize);
                });
            }

            if (savedAutoscroll === 'true') {
                autoScrollEnabled = true;
                if (autoscrollCheckbox) autoscrollCheckbox.checked = true;
            }

            // Load saved zoom
            const savedZoom = localStorage.getItem('garb-zoom');
            if (savedZoom) {
                document.body.dataset.zoom = savedZoom;
                const zoomSlider = document.getElementById('garb-zoom-slider');
                const zoomValue = document.getElementById('garb-zoom-value');
                if (zoomSlider) zoomSlider.value = savedZoom;
                if (zoomValue) zoomValue.textContent = `${savedZoom}%`;
            }
        } catch (e) {
            console.log("Could not load saved preferences");
        }
    }

    /**
     * Main injection function
     */
    function runInjection() {
        // Initialize global variables
        window.lineQueue = [];
        window.QUEUE_LENGTH = 5;
        window.MIN_PERCENT_READ = 5;
        window.startTime = 0;
        window.focusedTimeInSeconds = 0;
        window.targetSiteURL = location.href;
        window.eyeTrackingViewMode = 1;
        window.currentUser = null; // Will be set when user is retrieved

        // Reset baseline mode state for new article
        resetBaselineMode();

        console.log("GARB: Starting content extraction");

        // Show loading indicator immediately
        showStatusIndicator("Extracting article...");

        // Send tab ID to background
        safeSendMessage(
            {contentScriptQuery: "sendTabId", data: null},
            () => console.log("Background has tab ID")
        );

        // Start extraction - send URL and raw HTML
        safeSendMessage(
            {
                contentScriptQuery: "extractURLContent",
                data: {
                    url: window.targetSiteURL,
                    html: originalPageHTML
                }
            },
            result => {
                console.log("Extraction result:", result);
                if (!result) {
                    console.error("Failed to extract content - no response");
                    showStatusIndicator("Extraction failed", true);
                    return;
                }
                if (result.error && !result.content) {
                    console.error("Extraction error:", result.error);
                    showStatusIndicator("Extraction failed: " + result.error, true);
                    return;
                }

                processExtractedContent(result);
            }
        );
    }

    /**
     * Calculate estimated reading time
     */
    function calculateReadingTime(wordCount) {
        const wordsPerMinute = 200; // Average reading speed
        const minutes = Math.ceil(wordCount / wordsPerMinute);
        if (minutes < 1) return 'Less than 1 min';
        if (minutes === 1) return '1 min read';
        return `${minutes} min read`;
    }

    /**
     * Update reading progress display
     */
    function updateReadingProgress() {
        const progressFill = document.querySelector('.garb-progress-fill');
        const progressText = document.querySelector('.garb-reading-progress');

        if (totalWordsInArticle > 0) {
            const percentage = Math.min(100, Math.round((wordsRead / totalWordsInArticle) * 100));

            if (progressFill) {
                progressFill.style.width = `${percentage}%`;
            }
            if (progressText) {
                progressText.textContent = `${percentage}% read`;
            }
        }
    }

    /**
     * Process extracted content and build reader view
     */
    function processExtractedContent(result) {
        updateStatusIndicator("Building reader view...");

        // Build progress bar
        const progressBar = `
            <div class="garb-progress-bar">
                <div class="garb-progress-fill"></div>
            </div>
        `;

        // Build source info bar
        const domain = result.metadata?.domain || new URL(window.targetSiteURL).hostname;
        const sourceBar = `
            <div class="garb-source-bar">
                <span class="garb-source-domain">${escapeHtml(domain)}</span>
                <a href="${escapeHtml(window.targetSiteURL)}" class="garb-source-link" target="_blank">View Original</a>
            </div>
        `;

        // Build title
        const titleHTML = `<h1 class="garb-title">${escapeHtml(result.title)}</h1>`;

        // Calculate word count for reading time
        const contentText = result.content || '';
        const wordCount = contentText.split(/\s+/).filter(w => w.length > 0).length;
        totalWordsInArticle = wordCount;
        const readingTime = calculateReadingTime(wordCount);

        // Build metadata with reading time and progress
        let metadataHTML = '';
        const metaParts = [];
        if (result.metadata) {
            if (result.metadata.authors && result.metadata.authors.length > 0) {
                metaParts.push(`<span class="garb-author">${escapeHtml(result.metadata.authors.join(', '))}</span>`);
            }
            if (result.metadata.publish_date) {
                // Format date nicely
                let dateStr = result.metadata.publish_date;
                try {
                    const date = new Date(dateStr);
                    if (!isNaN(date)) {
                        dateStr = date.toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        });
                    }
                } catch (e) {}
                metaParts.push(`<span class="garb-date">${escapeHtml(dateStr)}</span>`);
            }
        }

        const metaLine = metaParts.length > 0
            ? `<div class="garb-metadata">${metaParts.join('<span class="garb-separator">·</span>')}</div>`
            : '';

        const readingInfoHTML = `
            <div class="garb-reading-info">
                <span class="garb-reading-time">${readingTime}</span>
                <span class="garb-reading-progress">0% read</span>
            </div>
        `;

        metadataHTML = metaLine + readingInfoHTML;

        // Build hero image - only use if it's a proper article image (not infobox/avatar)
        // Skip hero image for Wikipedia to avoid infobox images
        let imgHTML = '';
        const isWikipedia = window.targetSiteURL.includes('wikipedia.org');
        if (result.img_src && !isWikipedia) {
            // Additional check: skip small images or likely avatars
            imgHTML = `<img class="garb-hero-image" src="${escapeHtml(result.img_src)}" alt="">`;
        }

        // Build content
        let contentHTML = "";
        let spanNum = 0;

        if (result.formatted_content && result.formatted_content.length > 0) {
            contentHTML = buildFormattedContent(result.formatted_content);
            spanNum = countLines();
        } else {
            const plainResult = buildPlainTextContent(result.content || '');
            contentHTML = plainResult.html;
            spanNum = plainResult.lineCount;
        }

        // Settings panel HTML (compact layout)
        const settingsPanel = `
            <div class="garb-settings-panel" id="garb-settings-panel">
                <div class="garb-settings-row">
                    <div class="garb-settings-col">
                        <span class="garb-settings-label">Theme</span>
                        <div class="garb-theme-options">
                            <button class="garb-theme-btn theme-white-btn" data-theme="white" title="White"></button>
                            <button class="garb-theme-btn theme-gray-btn active" data-theme="gray" title="Gray"></button>
                            <button class="garb-theme-btn theme-cream-btn" data-theme="cream" title="Sepia"></button>
                            <button class="garb-theme-btn theme-dark-btn" data-theme="dark" title="Dark"></button>
                        </div>
                    </div>
                    <div class="garb-settings-col">
                        <span class="garb-settings-label">Size</span>
                        <div class="garb-size-options garb-zoom-control">
                            <button class="garb-size-btn size-xs" data-size="xs" title="Small">A</button>
                            <button class="garb-size-btn size-sm" data-size="small" title="Medium">A</button>
                            <button class="garb-size-btn size-md active" data-size="medium" title="Large">A</button>
                        </div>
                    </div>
                </div>
                <div class="garb-settings-section garb-font-section">
                    <span class="garb-settings-label">Font</span>
                    <div class="garb-font-options">
                        <button class="garb-font-btn active" data-font="serif">Serif</button>
                        <button class="garb-font-btn" data-font="sans">Sans</button>
                        <button class="garb-font-btn" data-font="sf">SF</button>
                        <button class="garb-font-btn" data-font="dyslexic">Dyslexic</button>
                    </div>
                </div>
                <div class="garb-settings-section garb-mode-section">
                    <span class="garb-settings-label">Mode</span>
                    <div class="garb-mode-options-compact">
                        <button class="garb-mode-btn-compact${currentTrackingMode === 'gaze' ? ' active' : ''}" data-mode="gaze" title="Eye tracking">Gaze</button>
                        <button class="garb-mode-btn-compact${currentTrackingMode === 'baseline' ? ' active' : ''}" data-mode="baseline" title="Fixed pace">Baseline</button>
                        <button class="garb-mode-btn-compact${currentTrackingMode === 'manual' ? ' active' : ''}" data-mode="manual" title="Arrow key navigation">Manual</button>
                        <button class="garb-mode-btn-compact${currentTrackingMode === 'none' ? ' active' : ''}" data-mode="none" title="No highlight">Off</button>
                    </div>
                </div>
                <div class="garb-settings-section garb-calibration-section">
                    <span class="garb-settings-label">Gaze Calibration</span>
                    <div class="garb-calibration-controls">
                        <button class="garb-calibrate-btn" id="garb-calibrate-btn" title="Calibrate gaze position">Calibrate</button>
                        <button class="garb-calibrate-clear-btn" id="garb-calibrate-clear" title="Clear calibration">Clear</button>
                        <span class="garb-calibration-badge" id="garb-calibration-badge"></span>
                    </div>
                </div>
                <div class="garb-settings-footer">
                    <label class="garb-autoscroll-compact" title="Toggle auto-scroll (A)">
                        <input type="checkbox" id="garb-autoscroll-checkbox">
                        <span>Auto-scroll <kbd class="garb-shortcut-hint">A</kbd></span>
                    </label>
                    <button class="garb-reset-btn-compact" id="garb-clear-progress" title="Clear progress">↺ Reset</button>
                </div>
            </div>
        `;

        // Critical inline styles for animation (loaded before external CSS)
        const criticalCSS = `
            <style>
                /* Critical animation styles - ensures animations work before external CSS loads */
                @keyframes garb-slide-up {
                    from { opacity: 0; transform: translateY(40px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes garb-fade-in {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes garb-slide-down {
                    from { opacity: 1; transform: translateY(0); }
                    to { opacity: 0; transform: translateY(40px); }
                }
                .garb-reader { opacity: 0; }
                .garb-reader.garb-animate-in { opacity: 1; }
                .garb-reader.garb-animate-in .garb-source-bar { animation: garb-fade-in 0.4s ease-out; }
                .garb-reader.garb-animate-in .garb-main { animation: garb-slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1); }
                .garb-reader.garb-animate-in .garb-article { animation: garb-slide-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both; }
                .garb-reader.garb-animate-in .garb-status { animation: garb-fade-in 0.3s ease-out 0.2s both; }
                .garb-reader.garb-animate-out .garb-main { animation: garb-slide-down 0.3s ease-in forwards; }
                .garb-reader.garb-animate-out .garb-source-bar,
                .garb-reader.garb-animate-out .garb-status { animation: garb-fade-in 0.3s ease-in reverse forwards; }
            </style>
        `;

        // Assemble the page
        const newPage = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(result.title)} - Reading Mode</title>
    ${criticalCSS}
</head>
<body class="garb-reader theme-gray font-serif size-medium" data-zoom="100" data-mode="${currentTrackingMode}">
    ${progressBar}
    ${sourceBar}
    ${settingsPanel}
    <main class="garb-main">
        <div class="garb-zoom-wrapper">
            <article class="garb-article">
                <header class="garb-header">
                    ${titleHTML}
                    ${metadataHTML}
                </header>
                ${imgHTML}
                <div class="garb-content">
                    ${contentHTML}
                </div>
            </article>
        </div>
    </main>
</body>
</html>`;

        document.documentElement.innerHTML = newPage;

        // IMPORTANT: Scroll to top of page for clean start
        window.scrollTo(0, 0);

        // Disable auto-scroll during initialization (prevent immediate scroll on first gaze)
        autoScrollInitialized = false;
        setTimeout(() => {
            autoScrollInitialized = true;
            console.log("GARB: Auto-scroll now enabled");
        }, 2000); // 2 second grace period for user to orient

        // Load CSS and trigger animation after it loads
        try {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = chrome.runtime.getURL('src/inject/inject.css');

            // Trigger slide-up animation after CSS loads
            link.onload = () => {
                requestAnimationFrame(() => {
                    document.body.classList.add('garb-animate-in');
                });
            };

            document.head.appendChild(link);

            // Fallback: trigger animation after short delay if onload doesn't fire
            setTimeout(() => {
                if (!document.body.classList.contains('garb-animate-in')) {
                    document.body.classList.add('garb-animate-in');
                }
            }, 100);
        } catch (error) {
            console.log("Could not load CSS - extension context may be invalid");
            extensionContextValid = false;
            // Still trigger animation with inline styles
            document.body.classList.add('garb-animate-in');
        }

        // Initialize settings toolbar
        initializeSettings();

        // Recreate status indicator
        showStatusIndicator("Connecting to eye tracker...");

        // Get user and start tracking
        safeSendMessage(
            {contentScriptQuery: "getUser", data: null},
            result => {
                window.currentUser = result; // Store globally for survey
                const userData = {
                    user: result,
                    url: window.targetSiteURL
                };
                getData(userData, spanNum);
            }
        );
    }

    function getData(userData, spanNum) {
        safeSendMessage(
            {contentScriptQuery: "getFromDatabase", data: userData},
            result => {
                const preloadData = result;

                // Initialize frequency arrays
                const quadFreqs = [];
                const dbQuadFreqs = [];

                for (let i = 0; i <= spanNum; i++) {
                    quadFreqs.push([0, 0, 0, 0, 0]);
                    dbQuadFreqs.push([0, 0, 0, 0, 0]);
                    wordReadProgress[i] = -1;
                }

                if (preloadData != null && Array.isArray(preloadData)) {
                    preloadData.forEach(item => {
                        if (item && item.quadFreqs) {
                            for (let i = 0; i < item.quadFreqs.length && i < dbQuadFreqs.length; i++) {
                                for (let j = 0; j < 5 && j < item.quadFreqs[i].length; j++) {
                                    dbQuadFreqs[i][j] += item.quadFreqs[i][j];
                                }
                            }
                        }
                    });

                    if (preloadData.length > 0) {
                        for (let i = 0; i < dbQuadFreqs.length; i++) {
                            for (let j = 0; j < 5; j++) {
                                dbQuadFreqs[i][j] /= preloadData.length;
                            }
                        }
                    }
                }

                // Initialize data logger for research data collection
                initDataLogger();

                // Initialize manual nudge controls and keyboard shortcuts
                createNudgeControl();
                setupKeyboardShortcuts();

                const pageSessionData = {
                    url: window.targetSiteURL,
                    title: document.querySelector('.garb-title')?.textContent || 'Unknown',
                    user: userData.user,
                    timestampStart: Date.now(),
                    timestampEnd: null,
                    sessionClosed: false,
                    quadFreqs: null,
                    // New research data fields
                    settings_snapshot: dataLogger ? dataLogger.getSettingsSnapshot() : null
                };

                runWebSocket(quadFreqs, dbQuadFreqs, pageSessionData);
            }
        );
    }

    function runWebSocket(quadFreqs, dbQuadFreqs, pageSessionData) {
        window.startTime = Date.now();

        if ("WebSocket" in window) {
            updateStatusIndicator("Connecting to eye tracker...");

            // Determine endpoint based on selected device
            // New endpoint: /gaze?device=consumer|pro (with device selection)
            // Legacy endpoint: /hello (backward compatible, Consumer only)
            const deviceType = selectedDevice ? selectedDevice.DeviceType.toLowerCase() : 'consumer';
            const newEndpoint = `/gaze?device=${deviceType}`;

            console.log("GARB: Connecting with device type:", deviceType);

            // Try new endpoint first, then legacy for backward compatibility
            tryConnect(`ws://127.0.0.1:8765${newEndpoint}`, quadFreqs, dbQuadFreqs)
                .catch(() => tryConnect(`ws://[::1]:8765${newEndpoint}`, quadFreqs, dbQuadFreqs))
                .catch(() => tryConnect(`ws://localhost:8765${newEndpoint}`, quadFreqs, dbQuadFreqs))
                // Fall back to legacy endpoint if new endpoint doesn't exist
                .catch(() => {
                    console.log("GARB: New endpoint not available, falling back to legacy /hello");
                    return tryConnect("ws://127.0.0.1:8765/hello", quadFreqs, dbQuadFreqs);
                })
                .catch(() => tryConnect("ws://[::1]:8765/hello", quadFreqs, dbQuadFreqs))
                .catch(() => tryConnect("ws://localhost:8765/hello", quadFreqs, dbQuadFreqs))
                .then(() => {
                    const deviceName = selectedDevice ? selectedDevice.DeviceName : 'Eye Tracker';
                    updateStatusIndicator(`${deviceName} active`);
                })
                .catch(() => {
                    console.error("Failed to connect to eye tracker service");
                    showStatusIndicator("Eye tracker not connected", true);
                });
        } else {
            showStatusIndicator("WebSocket not supported", true);
        }

        // Save data on page unload
        window.addEventListener("beforeunload", function() {
            console.log("GARB: Page unloading - saving session data");
            const totalTime = Math.floor((Date.now() - window.startTime) / 1000);

            pageSessionData.timestampEnd = Date.now();
            pageSessionData.quadFreqs = quadFreqs;
            pageSessionData.sessionClosed = true;

            // Add research data from DataLogger
            if (dataLogger) {
                // Finalize time tracking
                dataLogger.updateTextPresence(false);

                pageSessionData.summary = dataLogger.getSummary();

                // Use size-safe gaze data to prevent 413 Payload Too Large errors
                const gazeResult = dataLogger.getSizeSafeGazeData(400000); // ~400KB limit for gaze data
                pageSessionData.gaze_events_jsonl = gazeResult.data;
                if (gazeResult.sampled) {
                    pageSessionData.gaze_data_sampled = true;
                    pageSessionData.gaze_sampling_ratio = gazeResult.samplingRatio;
                    pageSessionData.gaze_original_count = gazeResult.originalCount;
                }

                pageSessionData.ui_events_jsonl = dataLogger.uiToJSONL();
                pageSessionData.settings_snapshot = dataLogger.getSettingsSnapshot();

                // Add device and environment metadata for research paper
                pageSessionData.device_metadata = dataLogger.getDeviceMetadata();
                pageSessionData.processing_methods = dataLogger.getProcessingMethods();
            }

            console.log("GARB: Saving session for user:", pageSessionData.user);

            // Use sendBeacon for reliable saving on page close (doesn't wait for response)
            const beaconUrl = 'https://garb-api-service.onrender.com/pageSessions';
            const blob = new Blob([JSON.stringify(pageSessionData)], { type: 'application/json' });
            const beaconSent = navigator.sendBeacon(beaconUrl, blob);
            console.log("GARB: sendBeacon result:", beaconSent);

            // Also try the normal message as backup
            safeSendMessage({
                contentScriptQuery: "saveToDatabase",
                data: pageSessionData
            });

            safeSendMessage({
                contentScriptQuery: "showDistractionMetric",
                data: {totalTime, focusedTimeInSeconds: window.focusedTimeInSeconds}
            });
        });
    }

    function tryConnect(url, quadFreqs, dbQuadFreqs) {
        return new Promise((resolve, reject) => {
            console.log("Attempting WebSocket connection to:", url);
            const ws = new WebSocket(url);
            const connectionTimeout = setTimeout(() => {
                ws.close();
                reject(new Error("Connection timeout"));
            }, 2000);

            ws.onopen = function() {
                clearTimeout(connectionTimeout);
                ws.send("Socket Opened");
                console.log("WebSocket connected to:", url);
                window.eyeTrackingWebSocket = ws;

                // Initialize gaze received time and start tracking lost check timer
                gazeState.lastGazeReceivedTime = Date.now();
                gazeState.lastValidGazeTime = Date.now();

                // Periodic check for tracking lost (when no gaze data received)
                gazeState.trackingLostCheckInterval = setInterval(() => {
                    const now = Date.now();
                    const timeSinceLastGaze = now - gazeState.lastGazeReceivedTime;

                    // If no gaze data received for longer than threshold, trigger tracking lost
                    if (timeSinceLastGaze > gazeState.trackingLostDuration) {
                        console.log("GARB: No gaze data for", timeSinceLastGaze, "ms - checking tracking lost");
                        checkTrackingLost(false);
                    }
                }, 500); // Check every 500ms
                console.log("GARB: Tracking lost check timer started");

                resolve(ws);
            };

            ws.onerror = function(error) {
                clearTimeout(connectionTimeout);
                reject(error);
            };

            ws.onmessage = createMessageHandler(ws, quadFreqs, dbQuadFreqs);

            ws.onclose = function(event) {
                clearTimeout(connectionTimeout);

                // Clear tracking lost check interval
                if (gazeState.trackingLostCheckInterval) {
                    clearInterval(gazeState.trackingLostCheckInterval);
                    gazeState.trackingLostCheckInterval = null;
                }

                if (!event.wasClean) {
                    console.log("WebSocket connection lost");
                    updateStatusIndicator("Connection lost", true);
                }
            };
        });
    }

    function createMessageHandler(ws, quadFreqs, dbQuadFreqs) {
        return function(evt) {
            const tokens = evt.data.split('|');

            if (tokens[0] === 'during' || tokens[0] === 'begin' || tokens[0] === 'gaze') {
                const screenX = parseFloat(tokens[1]);
                const screenY = parseFloat(tokens[2]);

                // Track when gaze data was last received (for tracking lost detection)
                gazeState.lastGazeReceivedTime = Date.now();

                // During calibration, collect raw samples instead of processing
                if (isCalibrating) {
                    calibrationRawSamples.push({ x: screenX, y: screenY, time: Date.now() });
                    return;
                }

                // Parse extended Pro data if available (tokens[3] onwards)
                // Pro format: gaze|x|y|pupilL|pupilR|originLX|originLY|originLZ|originRX|originRY|originRZ|validL|validR
                let proData = null;
                if (tokens.length > 3 && tokens[3] !== '') {
                    proData = {
                        pupilLeftDiameter: tokens[3] ? parseFloat(tokens[3]) : null,
                        pupilRightDiameter: tokens[4] ? parseFloat(tokens[4]) : null,
                        gazeOriginLeftX: tokens[5] ? parseFloat(tokens[5]) : null,
                        gazeOriginLeftY: tokens[6] ? parseFloat(tokens[6]) : null,
                        gazeOriginLeftZ: tokens[7] ? parseFloat(tokens[7]) : null,
                        gazeOriginRightX: tokens[8] ? parseFloat(tokens[8]) : null,
                        gazeOriginRightY: tokens[9] ? parseFloat(tokens[9]) : null,
                        gazeOriginRightZ: tokens[10] ? parseFloat(tokens[10]) : null,
                        leftEyeValidity: tokens[11] ? parseFloat(tokens[11]) : null,
                        rightEyeValidity: tokens[12] ? parseFloat(tokens[12]) : null
                    };
                }

                const coords = screenToViewport(screenX, screenY);
                const smoothed = smoothGaze(coords.x, coords.y);

                // Debug gaze dot — uncomment to see where the system thinks gaze is
                // updateGazeDot(smoothed.x, smoothed.y);

                // ALWAYS log gaze data regardless of mode (for research purposes)
                if (dataLogger) {
                    dataLogger.logGaze(
                        smoothed.x,
                        smoothed.y,
                        gazeState.confidence,
                        smoothed.velocity || { magnitude: 0 },
                        proData  // Pass extended Pro data if available
                    );
                }

                // CRITICAL: Check for tracking recovery FIRST (even when paused)
                // This allows auto-resume and overlay dismissal when gaze returns
                if (isPaused && pauseReason === 'tracking_lost' && currentTrackingMode === TRACKING_MODES.GAZE) {
                    // Check if gaze is within viewport (on screen at all)
                    const isOnScreen = smoothed.x >= 0 && smoothed.x <= window.innerWidth &&
                                       smoothed.y >= 0 && smoothed.y <= window.innerHeight;

                    if (isOnScreen) {
                        // Check if gaze is on text for full recovery
                        const lineMatch = mapGazeToLine(smoothed.y);
                        if (lineMatch) {
                            // Gaze is back on text - trigger full recovery
                            console.log("GARB: Gaze back on text, triggering recovery");
                            checkTrackingLost(true);
                        } else {
                            // Gaze is on screen but not on text - still dismiss overlay
                            // but don't fully resume (user might be looking at toolbar, etc.)
                            if (gazeState.trackingLost) {
                                console.log("GARB: Gaze back on screen (not text), dismissing overlay");
                                gazeState.trackingLost = false;
                                hideTrackingLostIndicator();
                            }
                        }
                    }
                }

                // Only process gaze for highlighting in GAZE mode and when not paused
                // In BASELINE mode, highlighting is driven by processBaselineHighlight()
                // In NONE mode, no highlighting at all
                if (currentTrackingMode === TRACKING_MODES.GAZE && !isPaused) {
                    processGaze(ws, quadFreqs, dbQuadFreqs, smoothed.x, smoothed.y, smoothed.velocity);
                }

            } else if (tokens[0] === "duration") {
                const temp = tokens[1].split(":");
                if (temp.length >= 3) {
                    window.focusedTimeInSeconds += parseFloat(temp[2]);
                }
            } else if (tokens[0] === "error") {
                showStatusIndicator("Eye tracker error: " + tokens[1], true);
            }
        };
    }

    // Gaze calibration offset (adjust if highlighting appears offset)
    // Positive Y moves highlight DOWN, negative moves it UP
    const GAZE_Y_OFFSET = 40; // Tobii reports gaze above actual focus point
    const GAZE_X_OFFSET = 0;
    // TODO: Add user calibration sliders to settings panel for fine-tuning

    /**
     * Convert screen coordinates to viewport coordinates.
     * The eye tracker sends raw coordinates in physical desktop pixels.
     * On mixed-DPI multi-monitor setups, dividing by DPR² converts Tobii's
     * physical coordinates into Chrome's CSS coordinate space.
     * When DPR=1 (100% scaling), this is a no-op.
     */
    function screenToViewport(screenX, screenY) {
        const dpr = window.devicePixelRatio || 1;

        // Measure actual chrome offset from mouse events (most reliable)
        // Falls back to capped estimate if no mouse data yet
        if (!screenToViewport._chromeCalibrated) {
            screenToViewport._chromeLeft = 8;  // reasonable default
            screenToViewport._chromeTop = Math.min(window.outerHeight - window.innerHeight, 180);
            document.addEventListener('mousemove', function _calibrateChrome(e) {
                screenToViewport._chromeLeft = e.screenX - e.clientX - window.screenX;
                screenToViewport._chromeTop = e.screenY - e.clientY - window.screenY;
                screenToViewport._chromeCalibrated = true;
                console.log('[GARB] Chrome offset calibrated:', screenToViewport._chromeLeft, screenToViewport._chromeTop);
                document.removeEventListener('mousemove', _calibrateChrome);
            }, { once: true });
        }
        const leftOffset = screenToViewport._chromeLeft;
        const topOffset = screenToViewport._chromeTop;

        let viewportX, viewportY;

        if (gazeCalibration) {
            // Calibrated path: empirically determined linear transform
            // fixedOffset captures the physical→CSS coordinate system mapping
            // window.screenX and chromeLeft are subtracted dynamically (handles window moves)
            // No GAZE_Y_OFFSET here — calibration already captures the correct mapping
            viewportX = screenX * gazeCalibration.scaleX + gazeCalibration.fixedOffsetX
                        - window.screenX - leftOffset;
            viewportY = screenY * gazeCalibration.scaleY + gazeCalibration.fixedOffsetY
                        - window.screenY - topOffset;
        } else {
            // Fallback: DPR² approximation (close but not exact on mixed-DPI)
            const dpr2 = dpr * dpr;
            viewportX = screenX / dpr2 - window.screenX - leftOffset + GAZE_X_OFFSET;
            viewportY = screenY / dpr2 - window.screenY - topOffset + GAZE_Y_OFFSET;
        }

        // Diagnostic logging (throttled every 3s)
        if (!screenToViewport._lastLog || Date.now() - screenToViewport._lastLog > 3000) {
            console.log('[GARB]',
                'raw:', screenX.toFixed(0), screenY.toFixed(0),
                '| mode:', gazeCalibration ? 'CALIBRATED' : 'FALLBACK(dpr²)',
                '| chrome:', leftOffset, topOffset,
                '| win:', window.screenX, window.screenY,
                '| viewport:', viewportX.toFixed(0), viewportY.toFixed(0)
            );
            screenToViewport._lastLog = Date.now();
        }

        return { x: viewportX, y: viewportY };
    }

    // ========================================
    // DEBUG GAZE DOT
    // ========================================

    let _gazeDotEl = null;

    function updateGazeDot(x, y) {
        if (!_gazeDotEl) {
            _gazeDotEl = document.createElement('div');
            _gazeDotEl.id = 'garb-gaze-dot';
            _gazeDotEl.style.cssText = `
                position: fixed;
                width: 12px;
                height: 12px;
                background: rgba(0, 255, 80, 0.7);
                border: 2px solid rgba(0, 255, 80, 1);
                border-radius: 50%;
                pointer-events: none;
                z-index: 2147483647;
                transform: translate(-50%, -50%);
                transition: left 0.03s linear, top 0.03s linear;
                box-shadow: 0 0 6px rgba(0, 255, 80, 0.5);
            `;
            document.body.appendChild(_gazeDotEl);
        }
        _gazeDotEl.style.left = x + 'px';
        _gazeDotEl.style.top = y + 'px';
    }

    // ========================================
    // GAZE CALIBRATION PROCEDURE
    // ========================================

    function calibSleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function collectRawGazeSamples(durationMs) {
        return new Promise(resolve => {
            calibrationRawSamples = [];
            setTimeout(() => {
                const samples = [...calibrationRawSamples];
                calibrationRawSamples = [];
                resolve(samples);
            }, durationMs);
        });
    }

    function trimmedMean(samples, trimFraction) {
        const n = samples.length;
        const trimCount = Math.floor(n * trimFraction);
        const sortedX = samples.map(s => s.x).sort((a, b) => a - b);
        const sortedY = samples.map(s => s.y).sort((a, b) => a - b);
        const tX = sortedX.slice(trimCount, n - trimCount);
        const tY = sortedY.slice(trimCount, n - trimCount);
        return {
            x: tX.reduce((a, b) => a + b, 0) / tX.length,
            y: tY.reduce((a, b) => a + b, 0) / tY.length
        };
    }

    /**
     * Run 2-point gaze calibration.
     * Shows crosshair targets at known viewport positions, collects raw Tobii
     * data while user fixates, then computes the empirical linear transform.
     */
    async function startGazeCalibration() {
        if (isCalibrating) return;
        isCalibrating = true;

        // 9-point calibration grid (3x3) for robust least-squares fit
        // Margins at 10%/50%/90% to cover full viewport range
        const positions = [0.10, 0.50, 0.90];
        const targets = [];
        for (const fy of positions) {
            for (const fx of positions) {
                targets.push({ fracX: fx, fracY: fy });
            }
        }
        const FIXATION_MS = 2000; // Collection time per point
        const SETTLE_MS = 700;    // Time for eyes to find target

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'garb-calibration-overlay';
        overlay.innerHTML = `
            <div class="garb-calibration-message">
                <h2>Gaze Calibration (9-point)</h2>
                <p>Look at each crosshair and hold your gaze steady.</p>
                <p class="garb-calibration-status">Preparing...</p>
            </div>
            <div class="garb-calibration-target" id="garb-calib-target">
                <div class="garb-calibration-crosshair"></div>
                <div class="garb-calibration-ring"></div>
            </div>
        `;
        document.body.appendChild(overlay);

        const targetEl = overlay.querySelector('#garb-calib-target');
        const statusEl = overlay.querySelector('.garb-calibration-status');
        const results = [];
        const numPoints = targets.length;

        for (let i = 0; i < numPoints; i++) {
            const vx = targets[i].fracX * window.innerWidth;
            const vy = targets[i].fracY * window.innerHeight;

            targetEl.style.left = vx + 'px';
            targetEl.style.top = vy + 'px';

            statusEl.textContent = `Point ${i + 1} of ${numPoints}: Look at the crosshair...`;
            await calibSleep(SETTLE_MS);

            statusEl.textContent = `Point ${i + 1} of ${numPoints}: Hold steady...`;
            const rawSamples = await collectRawGazeSamples(FIXATION_MS);

            if (rawSamples.length < 10) {
                statusEl.textContent = 'Not enough gaze data. Is the eye tracker running?';
                await calibSleep(2000);
                overlay.remove();
                isCalibrating = false;
                return;
            }

            const avgRaw = trimmedMean(rawSamples, 0.15);
            results.push({
                viewportX: vx, viewportY: vy,
                rawX: avgRaw.x, rawY: avgRaw.y,
                winX: window.screenX, winY: window.screenY,
                chromeL: screenToViewport._chromeLeft,
                chromeT: screenToViewport._chromeTop
            });

            console.log(`[GARB] Cal ${i + 1}/${numPoints}: target(${vx.toFixed(0)},${vy.toFixed(0)}) raw(${avgRaw.x.toFixed(1)},${avgRaw.y.toFixed(1)}) n=${rawSamples.length}`);
        }

        // Compute linear transform using least-squares fit across all 9 points
        const n = results.length;

        const absResults = results.map(r => ({
            absX: r.viewportX + r.winX + r.chromeL,
            absY: r.viewportY + r.winY + r.chromeT,
            rawX: r.rawX,
            rawY: r.rawY
        }));

        const rawMeanX = absResults.reduce((s, r) => s + r.rawX, 0) / n;
        const rawMeanY = absResults.reduce((s, r) => s + r.rawY, 0) / n;
        const absMeanX = absResults.reduce((s, r) => s + r.absX, 0) / n;
        const absMeanY = absResults.reduce((s, r) => s + r.absY, 0) / n;

        let sumXXraw = 0, sumXYraw = 0, sumYYraw = 0, sumYXabs = 0;
        for (const r of absResults) {
            const dRawX = r.rawX - rawMeanX;
            const dRawY = r.rawY - rawMeanY;
            const dAbsX = r.absX - absMeanX;
            const dAbsY = r.absY - absMeanY;
            sumXXraw += dRawX * dRawX;
            sumXYraw += dRawX * dAbsX;
            sumYYraw += dRawY * dRawY;
            sumYXabs += dRawY * dAbsY;
        }

        const scaleX = sumXXraw > 0 ? sumXYraw / sumXXraw : 1;
        const scaleY = sumYYraw > 0 ? sumYXabs / sumYYraw : 1;
        const fixedOffsetX = absMeanX - rawMeanX * scaleX;
        const fixedOffsetY = absMeanY - rawMeanY * scaleY;

        gazeCalibration = { scaleX, scaleY, fixedOffsetX, fixedOffsetY };

        // Log residual errors to assess fit quality
        let maxErrX = 0, maxErrY = 0, sumErrSq = 0;
        for (let i = 0; i < results.length; i++) {
            const r = absResults[i];
            const predX = r.rawX * scaleX + fixedOffsetX;
            const predY = r.rawY * scaleY + fixedOffsetY;
            const errX = predX - r.absX;
            const errY = predY - r.absY;
            maxErrX = Math.max(maxErrX, Math.abs(errX));
            maxErrY = Math.max(maxErrY, Math.abs(errY));
            sumErrSq += errX * errX + errY * errY;
            console.log(`[GARB] Residual pt ${i + 1}: errX=${errX.toFixed(1)}px errY=${errY.toFixed(1)}px`);
        }
        const rmsErr = Math.sqrt(sumErrSq / n);
        console.log(`[GARB] Calibration RMS error: ${rmsErr.toFixed(1)}px, max: (${maxErrX.toFixed(1)}, ${maxErrY.toFixed(1)})px`);

        // Save to localStorage
        try {
            localStorage.setItem(getCalibrationStorageKey(), JSON.stringify(gazeCalibration));
        } catch (e) {}

        console.log('[GARB] Calibration complete:', gazeCalibration);

        updateCalibrationBadge();

        statusEl.textContent = 'Calibration complete!';
        targetEl.style.display = 'none';
        await calibSleep(1000);

        overlay.remove();
        isCalibrating = false;
    }

    function updateCalibrationBadge() {
        const badge = document.getElementById('garb-calibration-badge');
        if (!badge) return;
        if (gazeCalibration) {
            badge.textContent = 'Calibrated';
            badge.className = 'garb-calibration-badge calibrated';
        } else {
            badge.textContent = 'Fallback';
            badge.className = 'garb-calibration-badge';
        }
    }

    /**
     * Smooth gaze coordinates using Exponential Moving Average (EMA)
     * Provides better responsiveness than median while maintaining stability
     * Also calculates velocity for fixation/saccade detection
     */
    function smoothGaze(x, y) {
        const now = Date.now();

        // Add to raw history for velocity calculation
        gazeState.rawHistory.push({ x, y, time: now });

        // Prune old samples
        while (gazeState.rawHistory.length > gazeState.maxHistorySize) {
            gazeState.rawHistory.shift();
        }
        while (gazeState.rawHistory.length > 0 &&
               now - gazeState.rawHistory[0].time > gazeState.maxHistoryAgeMs) {
            gazeState.rawHistory.shift();
        }

        // Calculate velocity from last two samples
        let velocity = { x: 0, y: 0, magnitude: 0 };
        if (gazeState.rawHistory.length >= 2) {
            const curr = gazeState.rawHistory[gazeState.rawHistory.length - 1];
            const prev = gazeState.rawHistory[gazeState.rawHistory.length - 2];
            const dt = (curr.time - prev.time) / 1000; // seconds

            if (dt > 0 && dt < 0.1) { // Sanity check
                velocity.x = (curr.x - prev.x) / dt;
                velocity.y = (curr.y - prev.y) / dt;
                velocity.magnitude = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
            }
        }

        // Smooth velocity over last 3 samples
        gazeState.velocityHistory.push(velocity.magnitude);
        if (gazeState.velocityHistory.length > 3) {
            gazeState.velocityHistory.shift();
        }
        const smoothedVelocity = gazeState.velocityHistory.reduce((a, b) => a + b, 0) /
                                 gazeState.velocityHistory.length;
        velocity.magnitude = smoothedVelocity;
        gazeState.velocity = velocity;

        // Initialize EMA on first sample
        if (gazeState.ema.x === null) {
            gazeState.ema.x = x;
            gazeState.ema.y = y;
            return { x, y, velocity };
        }

        // Adaptive alpha: faster response during movement, more smoothing when stable
        let alpha = gazeState.emaAlpha;
        if (velocity.magnitude > 200) {
            alpha = Math.min(0.6, gazeState.emaAlpha * 1.5);
        } else if (velocity.magnitude < 50) {
            alpha = Math.max(0.15, gazeState.emaAlpha * 0.7);
        }

        // Apply EMA
        gazeState.ema.x = alpha * x + (1 - alpha) * gazeState.ema.x;
        gazeState.ema.y = alpha * y + (1 - alpha) * gazeState.ema.y;

        // Calculate confidence based on velocity and consistency
        gazeState.confidence = calculateConfidence(velocity.magnitude);

        // Track time since last valid gaze on text
        gazeState.lastValidGazeTime = now;

        return {
            x: gazeState.ema.x,
            y: gazeState.ema.y,
            velocity
        };
    }

    /**
     * Calculate gaze confidence based on velocity and consistency
     */
    function calculateConfidence(velocityMagnitude) {
        let confidence = 1.0;

        // Velocity-based confidence
        if (velocityMagnitude > 2000) {
            confidence *= 0.2;
        } else if (velocityMagnitude > 1200) {
            confidence *= 0.5;
        } else if (velocityMagnitude > 800) {
            confidence *= 0.8;
        }

        // Consistency check
        if (gazeState.rawHistory.length >= 3) {
            const recent = gazeState.rawHistory.slice(-3);
            const avgX = recent.reduce((s, p) => s + p.x, 0) / 3;
            const avgY = recent.reduce((s, p) => s + p.y, 0) / 3;

            const variance = recent.reduce((s, p) => {
                return s + (p.x - avgX) ** 2 + (p.y - avgY) ** 2;
            }, 0) / 3;
            const stdDev = Math.sqrt(variance);

            if (stdDev > 100) {
                confidence *= 0.5;
            } else if (stdDev > 50) {
                confidence *= 0.8;
            }
        }

        // Smooth confidence
        gazeState.confidenceHistory.push(confidence);
        if (gazeState.confidenceHistory.length > 5) {
            gazeState.confidenceHistory.shift();
        }

        return gazeState.confidenceHistory.reduce((a, b) => a + b, 0) /
               gazeState.confidenceHistory.length;
    }

    /**
     * Update line rectangles cache for robust line mapping
     */
    function updateLineRectsCache() {
        const now = Date.now();

        if (now - gazeState.lineRectsCacheTime < gazeState.lineRectsCacheDuration) {
            return gazeState.lineRects;
        }

        const lines = document.querySelectorAll('.garb-line');
        gazeState.lineRects = [];

        lines.forEach((lineEl) => {
            const rect = lineEl.getBoundingClientRect();
            const lineNum = parseInt(lineEl.dataset.line);

            if (!isNaN(lineNum)) {
                gazeState.lineRects.push({
                    lineNum,
                    element: lineEl,
                    top: rect.top,
                    bottom: rect.bottom,
                    centerY: rect.top + rect.height / 2,
                    left: rect.left,
                    right: rect.right,
                    height: rect.height
                });
            }
        });

        gazeState.lineRects.sort((a, b) => a.top - b.top);
        gazeState.lineRectsCacheTime = now;

        return gazeState.lineRects;
    }

    /**
     * Map gaze Y coordinate to nearest line using bounding rect geometry
     */
    function mapGazeToLine(gazeY) {
        const lineRects = updateLineRectsCache();

        if (lineRects.length === 0) return null;

        let bestMatch = null;
        let bestDistance = Infinity;

        for (const lineRect of lineRects) {
            if (lineRect.bottom < 0 || lineRect.top > window.innerHeight) {
                continue;
            }

            // Use a gaze target biased toward the upper portion of the line.
            // When reading, eyes focus on the x-height (upper ~40% of the line box),
            // not the geometric center (which includes descenders + line spacing).
            const gazeTarget = lineRect.top + lineRect.height * 0.4;
            const distance = Math.abs(gazeY - gazeTarget);

            if (distance < bestDistance) {
                bestDistance = distance;
                bestMatch = {
                    lineNum: lineRect.lineNum,
                    distance,
                    element: lineRect.element,
                    rect: lineRect
                };
            }
        }

        return bestMatch;
    }

    /**
     * Line lock with hysteresis - prevents rapid line switching
     */
    function applyLineLockHysteresis(detectedLineNum, gazeY, lineMatch) {
        const now = Date.now();

        // Check for nudge lock - if recently nudged, keep current line
        if (now < gazeState.nudgeLockUntil) {
            // Don't allow gaze to override the nudge
            // console.log("Nudge lock active, ignoring gaze line:", detectedLineNum);
            return gazeState.currentLockedLine;
        }

        // Initialize on first call
        if (gazeState.currentLockedLine === -1) {
            gazeState.currentLockedLine = detectedLineNum;
            gazeState.candidateLine = -1;
            return detectedLineNum;
        }

        // Same line as locked - reset candidate
        if (detectedLineNum === gazeState.currentLockedLine) {
            gazeState.candidateLine = -1;
            gazeState.candidateLineCount = 0;
            return gazeState.currentLockedLine;
        }

        // Different line - check for margin-based instant switch
        if (lineMatch) {
            const currentLineRect = gazeState.lineRects.find(
                r => r.lineNum === gazeState.currentLockedLine
            );

            if (currentLineRect) {
                const currentDistance = Math.abs(gazeY - currentLineRect.centerY);
                const newDistance = lineMatch.distance;
                const margin = currentDistance - newDistance;

                if (margin > gazeState.lineMarginThreshold) {
                    const oldLine = gazeState.currentLockedLine;
                    gazeState.currentLockedLine = detectedLineNum;
                    gazeState.candidateLine = -1;
                    gazeState.candidateLineCount = 0;

                    // Log line switch event
                    if (dataLogger) {
                        dataLogger.logUIEvent('line_switch', {
                            old_line: oldLine,
                            new_line: detectedLineNum,
                            reason: 'margin_beat',
                            margin_px: Math.round(margin)
                        });

                        // Detect regression (going back to earlier line)
                        if (detectedLineNum < oldLine && oldLine > 0) {
                            dataLogger.logUIEvent('regression', {
                                from_line: oldLine,
                                to_line: detectedLineNum,
                                lines_back: oldLine - detectedLineNum
                            });
                        }
                    }

                    return detectedLineNum;
                }
            }
        }

        // Time-based hysteresis
        if (detectedLineNum !== gazeState.candidateLine) {
            gazeState.candidateLine = detectedLineNum;
            gazeState.candidateLineStartTime = now;
            gazeState.candidateLineCount = 1;
        } else {
            gazeState.candidateLineCount++;

            const dwellTime = now - gazeState.candidateLineStartTime;

            if (dwellTime >= gazeState.lineLockDurationMs) {
                const oldLine = gazeState.currentLockedLine;
                gazeState.currentLockedLine = detectedLineNum;
                gazeState.candidateLine = -1;
                gazeState.candidateLineCount = 0;

                // Log line switch event
                if (dataLogger) {
                    dataLogger.logUIEvent('line_switch', {
                        old_line: oldLine,
                        new_line: detectedLineNum,
                        reason: 'dwell_time',
                        dwell_ms: dwellTime
                    });

                    // Detect regression (going back to earlier line)
                    if (detectedLineNum < oldLine && oldLine > 0) {
                        dataLogger.logUIEvent('regression', {
                            from_line: oldLine,
                            to_line: detectedLineNum,
                            lines_back: oldLine - detectedLineNum
                        });
                    }
                }

                return detectedLineNum;
            }
        }

        return gazeState.currentLockedLine;
    }

    /**
     * Check for tracking lost state (gaze off text for too long)
     * UNIFIED: Single threshold for both auto-pause AND visual indicator
     */
    function checkTrackingLost(isOnText) {
        const now = Date.now();

        if (isOnText) {
            // Back on text - ALWAYS check for auto-resume first (regardless of trackingLost state)
            if (isPaused && pauseReason === 'tracking_lost' && currentTrackingMode === TRACKING_MODES.GAZE) {
                resumeTracking('tracking_recovered');
            }

            // Handle tracking lost state recovery
            if (gazeState.trackingLost) {
                const lostDuration = now - (gazeState.trackingLostStartTime || now);
                gazeState.trackingLost = false;

                if (dataLogger) {
                    dataLogger.logUIEvent('tracking_reacquired', {
                        duration_lost_ms: lostDuration,
                        resume_line: gazeState.lastStablePosition.line
                    });
                }

                hideTrackingLostIndicator();
            }

            gazeState.lastValidGazeTime = now;
        } else {
            // Off text
            const timeSinceLastValid = now - gazeState.lastValidGazeTime;

            // UNIFIED: Use single threshold for both pause AND indicator (GAZE mode only)
            if (currentTrackingMode === TRACKING_MODES.GAZE && !gazeState.trackingLost) {
                if (timeSinceLastValid > TRACKING_LOST_THRESHOLD_MS) {
                    console.log("GARB: Tracking lost triggered! Time since last valid:", timeSinceLastValid, "ms");

                    // Set tracking lost state
                    gazeState.trackingLost = true;
                    gazeState.trackingLostStartTime = now;

                    // Auto-pause
                    if (!isPaused) {
                        pauseTracking('tracking_lost');
                    }

                    // Log event
                    if (dataLogger) {
                        dataLogger.logUIEvent('tracking_lost', {
                            last_line: gazeState.lastStablePosition.line,
                            last_word: gazeState.lastStablePosition.word
                        });
                    }

                    // Show visual indicator
                    showTrackingLostIndicator();
                }
            }
        }
    }

    // Tracking lost indicator element
    let trackingLostOverlay = null;

    /**
     * Show tracking lost visual indicator
     */
    function showTrackingLostIndicator() {
        console.log("GARB: Showing tracking lost indicator");
        if (trackingLostOverlay) return;

        trackingLostOverlay = document.createElement('div');
        trackingLostOverlay.className = 'garb-tracking-lost-overlay';
        document.body.appendChild(trackingLostOverlay);
        console.log("GARB: Tracking lost overlay added to DOM");

        // Add resume marker to last stable line
        const lastLine = gazeState.lastStablePosition.line;
        if (lastLine >= 0) {
            const lineEl = document.querySelector(`.garb-line[data-line="${lastLine}"]`);
            if (lineEl) {
                lineEl.classList.add('garb-resume-marker');
            }
        }

        // Fade gaze bubble
        if (gazeBubble) {
            gazeBubble.style.opacity = '0.2';
        }
        if (gazeBubbleTrail) {
            gazeBubbleTrail.style.opacity = '0.1';
        }

        updateStatusIndicator("Look at screen to continue", true);
    }

    /**
     * Hide tracking lost indicator
     */
    function hideTrackingLostIndicator() {
        if (trackingLostOverlay) {
            trackingLostOverlay.remove();
            trackingLostOverlay = null;
        }

        // Remove resume marker
        const resumeMarker = document.querySelector('.garb-resume-marker');
        if (resumeMarker) {
            resumeMarker.classList.remove('garb-resume-marker');
        }

        // Restore gaze bubble
        if (gazeBubble) {
            gazeBubble.style.opacity = '1';
        }
        if (gazeBubbleTrail) {
            gazeBubbleTrail.style.opacity = '0.8';
        }

        updateStatusIndicator("Eye tracking active");
    }

    // Manual nudge control element
    let nudgeControl = null;

    /**
     * Create manual nudge buttons
     */
    function createNudgeControl() {
        if (nudgeControl) return;

        nudgeControl = document.createElement('div');
        nudgeControl.className = 'garb-nudge-control';
        nudgeControl.innerHTML = `
            <button class="garb-nudge-btn" data-direction="up" title="Move up (Alt+Up)">▲</button>
            <button class="garb-nudge-btn" data-direction="down" title="Move down (Alt+Down)">▼</button>
        `;

        nudgeControl.addEventListener('click', (e) => {
            const btn = e.target.closest('.garb-nudge-btn');
            if (btn) {
                const direction = btn.dataset.direction;
                manualNudge(direction);
            }
        });

        document.body.appendChild(nudgeControl);
    }

    /**
     * Manual nudge - move highlight up or down one line
     */
    function manualNudge(direction) {
        console.log("Manual nudge:", direction);

        // For baseline mode, use pace-based nudge
        if (currentTrackingMode === TRACKING_MODES.BASELINE) {
            const linesDelta = direction === 'up' ? -1 : 1;
            nudgeBaselinePosition(linesDelta);

            // Log the nudge event
            if (dataLogger) {
                dataLogger.logUIEvent('manual_nudge', {
                    direction: direction,
                    mode: 'baseline',
                    new_word_index: baselineWordIndex
                });
            }

            // Brief visual feedback
            if (nudgeControl) {
                const btn = nudgeControl.querySelector(`[data-direction="${direction}"]`);
                if (btn) {
                    btn.style.transform = 'scale(0.9)';
                    setTimeout(() => { btn.style.transform = ''; }, 100);
                }
            }
            return;
        }

        // Force refresh line rects cache
        gazeState.lineRectsCacheTime = 0;
        const lineRects = updateLineRectsCache();

        if (lineRects.length === 0) {
            console.log("No lines found for nudge");
            return;
        }

        let currentLine = gazeState.currentLockedLine;
        let currentIdx = -1;

        // If no current line, start from the first visible line
        if (currentLine < 0) {
            // Find first line in viewport
            for (let i = 0; i < lineRects.length; i++) {
                if (lineRects[i].top >= 0 && lineRects[i].top < window.innerHeight) {
                    currentIdx = i;
                    currentLine = lineRects[i].lineNum;
                    break;
                }
            }
            if (currentIdx < 0) {
                currentIdx = 0;
                currentLine = lineRects[0].lineNum;
            }
        } else {
            currentIdx = lineRects.findIndex(r => r.lineNum === currentLine);
            if (currentIdx < 0) {
                // Current line not in cache, find closest
                currentIdx = 0;
            }
        }

        let newIdx;
        if (direction === 'up') {
            newIdx = Math.max(0, currentIdx - 1);
        } else {
            newIdx = Math.min(lineRects.length - 1, currentIdx + 1);
        }

        const newLineNum = lineRects[newIdx].lineNum;
        const oldLine = gazeState.currentLockedLine;

        console.log("Nudge: old line", oldLine, "-> new line", newLineNum);

        // Update locked line with nudge lock (prevents gaze from overriding)
        gazeState.currentLockedLine = newLineNum;
        gazeState.nudgeLockUntil = Date.now() + gazeState.nudgeLockDuration;
        lastStableLineNum = newLineNum;
        lastStableWordIdx = 0;

        // Clear any existing line highlighting
        clearOtherActiveLines(newLineNum);

        // Update last stable position for resume marker
        gazeState.lastStablePosition = { line: newLineNum, word: 0 };

        // Log the nudge event
        if (dataLogger) {
            dataLogger.logUIEvent('manual_nudge', {
                direction: direction,
                old_line: oldLine,
                new_line: newLineNum
            });
        }

        // Update highlighting
        const lineEl = document.querySelector(`.garb-line[data-line="${newLineNum}"]`);
        if (lineEl) {
            applyWordHighlighting(lineEl, newLineNum, wordReadProgress[newLineNum] || -1, 0);

            // Scroll line into view if needed
            const rect = lineEl.getBoundingClientRect();
            if (rect.top < 100 || rect.bottom > window.innerHeight - 100) {
                lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        // Brief visual feedback
        if (nudgeControl) {
            const btn = nudgeControl.querySelector(`[data-direction="${direction}"]`);
            if (btn) {
                btn.style.transform = 'scale(0.9)';
                setTimeout(() => { btn.style.transform = ''; }, 100);
            }
        }
    }

    /**
     * Setup keyboard shortcuts
     */
    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Alt+Up: Nudge up
            if (e.altKey && e.key === 'ArrowUp') {
                e.preventDefault();
                manualNudge('up');
            }

            // Alt+Down: Nudge down
            if (e.altKey && e.key === 'ArrowDown') {
                e.preventDefault();
                manualNudge('down');
            }

            // Alt+Shift+T: Toggle tracking (send message to popup)
            if (e.altKey && e.shiftKey && e.key === 'T') {
                e.preventDefault();
                safeSendMessage({ action: 'toggleTracking' });
            }

            // L key: Toggle pause/lock (no modifiers to avoid conflicts)
            if ((e.key === 'l' || e.key === 'L') && !e.altKey && !e.ctrlKey && !e.metaKey) {
                // Don't trigger if user is typing in an input field
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    togglePause('manual');
                }
            }

            // A key: Toggle auto-scroll
            if ((e.key === 'a' || e.key === 'A') && !e.altKey && !e.ctrlKey && !e.metaKey) {
                // Don't trigger if user is typing in an input field
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    e.preventDefault();
                    toggleAutoScroll();
                }
            }

            // Arrow keys for Manual mode (plain, no modifiers)
            if (currentTrackingMode === TRACKING_MODES.MANUAL && !e.altKey && !e.ctrlKey && !e.metaKey) {
                if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        manualAdvanceLine('down');
                    }
                    if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        manualAdvanceLine('up');
                    }
                }
            }
        });
    }

    /**
     * Toggle auto-scroll and update UI
     */
    function toggleAutoScroll() {
        autoScrollEnabled = !autoScrollEnabled;

        // Update checkbox if it exists
        const checkbox = document.getElementById('garb-autoscroll-checkbox');
        if (checkbox) {
            checkbox.checked = autoScrollEnabled;
        }

        // Save preference
        try {
            localStorage.setItem('garb-autoscroll', autoScrollEnabled ? 'true' : 'false');
        } catch (e) {}

        // Show brief visual feedback
        showAutoScrollFeedback(autoScrollEnabled);

        console.log("GARB: Auto-scroll toggled:", autoScrollEnabled);
    }

    /**
     * Show brief visual feedback when auto-scroll is toggled
     */
    function showAutoScrollFeedback(enabled) {
        // Remove existing feedback if any
        const existing = document.querySelector('.garb-autoscroll-feedback');
        if (existing) existing.remove();

        const feedback = document.createElement('div');
        feedback.className = 'garb-autoscroll-feedback';
        feedback.textContent = enabled ? 'Auto-scroll ON' : 'Auto-scroll OFF';
        feedback.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: ${enabled ? 'rgba(76, 175, 80, 0.9)' : 'rgba(100, 100, 100, 0.9)'};
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 500;
            z-index: 100001;
            pointer-events: none;
            opacity: 1;
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(feedback);

        // Fade out and remove
        setTimeout(() => {
            feedback.style.opacity = '0';
            setTimeout(() => feedback.remove(), 300);
        }, 800);
    }

    /**
     * Process gaze data and update word-by-word highlighting
     * Uses line lock with hysteresis for stability
     */
    function processGaze(ws, quadFreqs, dbQuadFreqs, x, y, velocity = { magnitude: 0 }) {
        // Check for saccade (rapid eye movement) - freeze during saccades
        if (velocity.magnitude > gazeState.saccadeThreshold) {
            if (!gazeState.saccadeActive) {
                gazeState.saccadeActive = true;
                gazeState.saccadeFreezeStartTime = Date.now();
            }
            return; // Skip processing during saccade
        } else if (gazeState.saccadeActive) {
            const freezeDuration = Date.now() - gazeState.saccadeFreezeStartTime;
            if (freezeDuration < gazeState.saccadeFreezeMinDuration) {
                return; // Still in freeze period
            }
            gazeState.saccadeActive = false;
        }

        // Use robust line mapping
        const lineMatch = mapGazeToLine(y);
        let lineEl = null;
        let lineNum = -1;

        if (lineMatch) {
            lineEl = lineMatch.element;
            lineNum = lineMatch.lineNum;
        } else {
            // Fallback to elementFromPoint
            const el = document.elementFromPoint(x, y);
            if (!el) {
                checkTrackingLost(false);
                if (dataLogger) dataLogger.updateTextPresence(false);
                return;
            }

            if (el.classList.contains('garb-word')) {
                lineEl = el.closest('.garb-line');
            } else if (el.classList.contains('garb-line')) {
                lineEl = el;
            } else {
                lineEl = el.closest('.garb-line');
            }

            if (!lineEl) {
                checkTrackingLost(false);
                if (dataLogger) dataLogger.updateTextPresence(false);
                return;
            }

            lineNum = parseInt(lineEl.dataset.line);
        }

        // Valid gaze on text
        checkTrackingLost(true);
        if (dataLogger) dataLogger.updateTextPresence(true);

        if (isNaN(lineNum) || lineNum < 0 || lineNum >= quadFreqs.length) return;

        if (wordReadProgress[lineNum] === undefined) {
            wordReadProgress[lineNum] = -1;
        }

        // Apply line lock with hysteresis
        const lockedLineNum = applyLineLockHysteresis(lineNum, y, lineMatch);

        // Get the locked line element
        const lockedLineEl = document.querySelector(`.garb-line[data-line="${lockedLineNum}"]`);
        if (!lockedLineEl) return;

        // Find closest word by position on the LOCKED line (not the detected line)
        const words = lockedLineEl.querySelectorAll('.garb-word');
        let rawWordIdx = 0;
        let closestDist = Infinity;

        words.forEach((w, idx) => {
            const rect = w.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const dist = Math.abs(x - centerX);
            if (dist < closestDist) {
                closestDist = dist;
                rawWordIdx = idx;
            }
        });

        // Word-level stabilization (simpler than before)
        let stableWordIdx = lastStableWordIdx;

        if (lockedLineNum !== lastStableLineNum) {
            // Line changed - accept new word position
            stableWordIdx = rawWordIdx;
            lastStableLineNum = lockedLineNum;
            lastStableWordIdx = rawWordIdx;
        } else if (Math.abs(rawWordIdx - lastStableWordIdx) <= 1) {
            // Adjacent word - accept immediately
            stableWordIdx = rawWordIdx;
            lastStableWordIdx = rawWordIdx;
        } else {
            // Jump of multiple words - require brief stability
            stabilityCounter++;
            if (stabilityCounter >= 2) {
                stableWordIdx = rawWordIdx;
                lastStableWordIdx = rawWordIdx;
                stabilityCounter = 0;
            }
        }

        // Initialize if first run
        if (lastStableLineNum === -1) {
            lastStableLineNum = lockedLineNum;
            lastStableWordIdx = rawWordIdx;
            stableWordIdx = rawWordIdx;
        }

        // Save stable position for resume marker
        gazeState.lastStablePosition = {
            line: lockedLineNum,
            word: stableWordIdx
        };

        // Progressive fill - only advance reading progress, never go back
        if (stableWordIdx > wordReadProgress[lockedLineNum]) {
            const newWordsRead = stableWordIdx - wordReadProgress[lockedLineNum];
            wordsRead += newWordsRead;
            wordReadProgress[lockedLineNum] = stableWordIdx;
            updateReadingProgress();

            // Update dataLogger summary
            if (dataLogger) {
                dataLogger.summary.total_words_read = wordsRead;
                dataLogger.summary.total_lines_read = Object.keys(wordReadProgress).length;
            }
        }

        // Apply highlighting with stable position
        const now = Date.now();
        let indicatorWordIdx = stableWordIdx;

        // Only update indicator if enough time has passed
        const shouldUpdateIndicator = (now - lastIndicatorChangeTime > INDICATOR_MIN_DELAY) ||
            (lockedLineNum !== displayedCurrentLine) ||
            (Math.abs(stableWordIdx - displayedCurrentWord) > 2);

        if (shouldUpdateIndicator) {
            displayedCurrentLine = lockedLineNum;
            displayedCurrentWord = stableWordIdx;
            lastIndicatorChangeTime = now;
        } else {
            indicatorWordIdx = displayedCurrentWord;
        }

        applyWordHighlighting(lockedLineEl, lockedLineNum, wordReadProgress[lockedLineNum], indicatorWordIdx);

        // Research-based auto-scroll for Mode A (Gaze)
        // Based on Kumar & Winograd (2007) and Sharmin et al. (2013):
        // - Users have a "preferred reading zone" (middle section of viewport)
        // - Scroll triggers when gaze dwells in trigger zones for ~300ms
        // - Supports both scroll down (gaze at bottom) and scroll up (gaze at top)
        if (autoScrollEnabled && autoScrollInitialized && lockedLineEl) {
            const rect = lockedLineEl.getBoundingClientRect();
            const viewportHeight = window.innerHeight;
            const linePosition = rect.top / viewportHeight;

            // Check scroll down trigger (gaze below preferred zone)
            const inScrollDownZone = linePosition > SCROLL_ZONE_BOTTOM;
            // Check scroll up trigger (gaze above preferred zone)
            const inScrollUpZone = linePosition < SCROLL_ZONE_TOP && window.scrollY > 50;

            if (inScrollDownZone) {
                scrollUpTriggerStartTime = 0; // Reset up timer
                if (scrollTriggerStartTime === 0) {
                    scrollTriggerStartTime = now;
                } else {
                    const dwellTime = now - scrollTriggerStartTime;
                    if (dwellTime >= SCROLL_DWELL_TIME && now - lastScrollTime > SCROLL_COOLDOWN_GAZE) {
                        const targetPosition = viewportHeight * 0.35; // Bring to comfortable position
                        const scrollAmount = rect.top - targetPosition;

                        if (scrollAmount > 50) {
                            smoothScrollBy(scrollAmount, SCROLL_DURATION_MS);

                            if (dataLogger) {
                                dataLogger.logUIEvent('scroll', {
                                    direction: 'down',
                                    delta_y: Math.round(scrollAmount),
                                    triggered_by: 'gaze_auto',
                                    dwell_time_ms: dwellTime
                                });
                            }
                            lastScrollTime = now;
                            scrollTriggerStartTime = 0;
                        }
                    }
                }
            } else if (inScrollUpZone) {
                scrollTriggerStartTime = 0; // Reset down timer
                if (scrollUpTriggerStartTime === 0) {
                    scrollUpTriggerStartTime = now;
                } else {
                    const dwellTime = now - scrollUpTriggerStartTime;
                    if (dwellTime >= SCROLL_DWELL_TIME && now - lastScrollTime > SCROLL_COOLDOWN_GAZE) {
                        const targetPosition = viewportHeight * 0.45; // Bring to center
                        const scrollAmount = rect.top - targetPosition;

                        if (scrollAmount < -50) {
                            smoothScrollBy(scrollAmount, SCROLL_DURATION_MS);

                            if (dataLogger) {
                                dataLogger.logUIEvent('scroll', {
                                    direction: 'up',
                                    delta_y: Math.round(scrollAmount),
                                    triggered_by: 'gaze_auto',
                                    dwell_time_ms: dwellTime
                                });
                            }
                            lastScrollTime = now;
                            scrollUpTriggerStartTime = 0;
                        }
                    }
                }
            } else {
                // Gaze in preferred zone - reset both timers
                scrollTriggerStartTime = 0;
                scrollUpTriggerStartTime = 0;
            }
        }

        // Update quad frequencies
        const wordCount = parseInt(lineEl.dataset.wordCount) || 1;
        const quadIdx = Math.floor((rawWordIdx / wordCount) * 4);
        if (lineNum < quadFreqs.length) {
            quadFreqs[lineNum][Math.min(3, Math.max(0, quadIdx))] += 1;
        }

        // Send tracking data
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(`${lineNum}|${rawWordIdx}|${Date.now()}`);
        }
    }

    // ========================================
    // MODE B: BASELINE (VIEWPORT-CENTER) HIGHLIGHTING
    // ========================================

    /**
     * Build a flat map of all words in document order for pace-based baseline
     * Each entry: {line: lineNum, wordIdx: wordIdxInLine, globalIdx: globalWordIndex}
     */
    function buildBaselineWordMap() {
        baselineWordMap = [];
        const lines = document.querySelectorAll('.garb-line');
        let globalIdx = 0;

        lines.forEach(lineEl => {
            const lineNum = parseInt(lineEl.dataset.line);
            const words = lineEl.querySelectorAll('.garb-word');

            words.forEach((wordEl, wordIdx) => {
                baselineWordMap.push({
                    line: lineNum,
                    wordIdx: wordIdx,
                    globalIdx: globalIdx,
                    element: wordEl
                });
                globalIdx++;
            });
        });

        baselineTotalWords = baselineWordMap.length;
        baselineInitialized = true;
        console.log(`GARB: Built baseline word map with ${baselineTotalWords} words`);
    }

    /**
     * Process pace-based baseline mode (Mode B) - "Teleprompter" style
     * Advances through text at a fixed WPM rate, providing a fair control condition
     * that simulates what a non-gaze reading aid would do
     */
    function processBaselineHighlight() {
        if (currentTrackingMode !== TRACKING_MODES.BASELINE) return;
        if (isPaused) return;
        if (!baselineInitialized || baselineTotalWords === 0) return;

        const now = Date.now();

        // Calculate effective reading time (excluding paused time)
        const effectiveTime = now - baselineStartTime - baselinePausedDuration;

        // Calculate target word index based on WPM
        // WPM / 60 = words per second, / 1000 = words per millisecond
        const wordsPerMs = baselineWPM / 60000;
        let targetWordIndex = Math.floor(effectiveTime * wordsPerMs);

        // Clamp to valid range
        targetWordIndex = Math.max(0, Math.min(targetWordIndex, baselineTotalWords - 1));

        // Get current word info from map
        const wordInfo = baselineWordMap[targetWordIndex];
        if (!wordInfo) return;

        const lineNum = wordInfo.line;
        const wordIdx = wordInfo.wordIdx;

        // Update baseline word index for nudge controls
        baselineWordIndex = targetWordIndex;

        // Get line element
        const lineEl = document.querySelector(`.garb-line[data-line="${lineNum}"]`);
        if (!lineEl) return;

        // Initialize word progress for this line if needed
        if (wordReadProgress[lineNum] === undefined) {
            wordReadProgress[lineNum] = -1;
        }

        // Save stable position for resume marker
        gazeState.lastStablePosition = {
            line: lineNum,
            word: wordIdx
        };

        // Progressive fill - mark all words up to current as read
        if (wordIdx > wordReadProgress[lineNum]) {
            const newWordsRead = wordIdx - wordReadProgress[lineNum];
            wordsRead += newWordsRead;
            wordReadProgress[lineNum] = wordIdx;
            updateReadingProgress();

            if (dataLogger) {
                dataLogger.summary.total_words_read = wordsRead;
                dataLogger.summary.total_lines_read = Object.keys(wordReadProgress).length;
            }
        }

        // Also mark previous lines as complete
        for (let prevLine = 0; prevLine < lineNum; prevLine++) {
            const prevLineEl = document.querySelector(`.garb-line[data-line="${prevLine}"]`);
            if (prevLineEl) {
                const prevWordCount = prevLineEl.querySelectorAll('.garb-word').length;
                if (wordReadProgress[prevLine] === undefined || wordReadProgress[prevLine] < prevWordCount - 1) {
                    const prevProgress = wordReadProgress[prevLine] || -1;
                    const newWords = (prevWordCount - 1) - prevProgress;
                    if (newWords > 0) {
                        wordsRead += newWords;
                        wordReadProgress[prevLine] = prevWordCount - 1;
                    }
                }
            }
        }

        // Apply highlighting
        const shouldUpdateIndicator = (now - lastIndicatorChangeTime > INDICATOR_MIN_DELAY) ||
            (lineNum !== displayedCurrentLine) ||
            (Math.abs(wordIdx - displayedCurrentWord) > 0);

        if (shouldUpdateIndicator) {
            displayedCurrentLine = lineNum;
            displayedCurrentWord = wordIdx;
            lastIndicatorChangeTime = now;
        }

        applyWordHighlighting(lineEl, lineNum, wordReadProgress[lineNum], wordIdx);

        // Auto-scroll for Mode B (Baseline) - uses same preferred reading zone as Mode A
        // No dwell time needed since baseline is pace-controlled (deterministic position)
        if (autoScrollEnabled && autoScrollInitialized && lineEl) {
            const viewportHeight = window.innerHeight;
            if (now - lastScrollTime > SCROLL_COOLDOWN_BASELINE) {
                const rect = lineEl.getBoundingClientRect();

                // Check if line is below preferred reading zone
                const linePosition = rect.top / viewportHeight;

                if (linePosition > SCROLL_ZONE_BOTTOM) {
                    // Bring line to preferred reading zone
                    const targetPosition = viewportHeight * SCROLL_ZONE_TOP;
                    const scrollAmount = rect.top - targetPosition;

                    if (scrollAmount > 50) {
                        // Use custom smooth scroll for consistent, gradual animation
                        smoothScrollBy(scrollAmount, SCROLL_DURATION_MS);

                        if (dataLogger) {
                            dataLogger.logUIEvent('scroll', {
                                direction: 'down',
                                delta_y: Math.round(scrollAmount),
                                triggered_by: 'baseline_auto',
                                wpm: baselineWPM
                            });
                        }

                        lastScrollTime = now;
                    }
                }
            }
        }

        // Log current position periodically (every ~1 second)
        if (dataLogger && targetWordIndex % Math.ceil(baselineWPM / 60) === 0) {
            dataLogger.logUIEvent('baseline_position', {
                global_word_index: targetWordIndex,
                line: lineNum,
                word_in_line: wordIdx,
                wpm: baselineWPM,
                effective_time_ms: effectiveTime
            });
        }
    }

    /**
     * Start pace-based baseline mode
     */
    function startBaselineMode() {
        // Build word map if not done
        if (!baselineInitialized) {
            buildBaselineWordMap();
        }

        // Initialize timing
        const now = Date.now();

        // If resuming, don't reset start time - just continue from pause
        if (baselineStartTime === 0) {
            baselineStartTime = now;
            baselineWordIndex = 0;
            baselinePausedDuration = 0;
        }

        // Start update interval
        if (baselineUpdateInterval) {
            clearInterval(baselineUpdateInterval);
        }
        baselineUpdateInterval = setInterval(processBaselineHighlight, BASELINE_UPDATE_RATE_MS);

        console.log(`GARB: Baseline mode started at ${baselineWPM} WPM`);
    }

    /**
     * Stop the baseline update interval
     */
    function stopBaselineMode() {
        if (baselineUpdateInterval) {
            clearInterval(baselineUpdateInterval);
            baselineUpdateInterval = null;
        }
        console.log("GARB: Baseline mode stopped");
    }

    // ========================================
    // MANUAL MODE (arrow-key line-by-line)
    // ========================================

    function startManualMode() {
        manualLineElements = Array.from(document.querySelectorAll('.garb-line'));
        if (manualLineElements.length === 0) {
            console.log('GARB: Manual mode - no .garb-line elements found');
            return;
        }

        manualModeActive = true;

        // Find the first line visible in the viewport
        manualCurrentLine = 0;
        for (let i = 0; i < manualLineElements.length; i++) {
            const rect = manualLineElements[i].getBoundingClientRect();
            if (rect.top >= 0 && rect.top < window.innerHeight) {
                manualCurrentLine = i;
                break;
            }
        }

        highlightManualLine(manualCurrentLine);
        console.log(`GARB: Manual mode started at line ${manualCurrentLine}`);

        if (dataLogger) {
            dataLogger.logUIEvent('manual_start', {
                line_index: manualCurrentLine,
                total_lines: manualLineElements.length
            });
        }
    }

    function stopManualMode() {
        manualModeActive = false;
        clearAllHighlighting();
        console.log('GARB: Manual mode stopped');
    }

    function highlightManualLine(lineIndex) {
        if (lineIndex < 0 || lineIndex >= manualLineElements.length) return;

        // Remove active highlight from all lines
        document.querySelectorAll('.garb-line-active').forEach(el => {
            el.classList.remove('garb-line-active');
        });

        // Mark all lines before current as complete (read)
        for (let i = 0; i < lineIndex; i++) {
            manualLineElements[i].classList.add('garb-line-complete');
        }

        // Highlight current line
        const lineEl = manualLineElements[lineIndex];
        lineEl.classList.add('garb-line-active');

        // Mark all words in current line as read (whole-line highlight)
        const words = lineEl.querySelectorAll('.garb-word');
        words.forEach(w => {
            w.classList.add('garb-word-read');
        });

        // Auto-scroll if enabled
        if (autoScrollEnabled && autoScrollInitialized) {
            const now = Date.now();
            if (now - lastScrollTime > SCROLL_COOLDOWN_BASELINE) {
                const rect = lineEl.getBoundingClientRect();
                const viewportHeight = window.innerHeight;
                const linePosition = rect.top / viewportHeight;

                if (linePosition > SCROLL_ZONE_BOTTOM || linePosition < SCROLL_ZONE_TOP) {
                    const targetPosition = viewportHeight * 0.35;
                    const scrollAmount = rect.top - targetPosition;

                    if (Math.abs(scrollAmount) > 50) {
                        smoothScrollBy(scrollAmount, SCROLL_DURATION_MS);
                        lastScrollTime = now;
                    }
                }
            }
        }
    }

    function manualAdvanceLine(direction) {
        if (!manualModeActive || manualLineElements.length === 0) return;

        const oldLine = manualCurrentLine;

        if (direction === 'down' && manualCurrentLine < manualLineElements.length - 1) {
            manualCurrentLine++;
        } else if (direction === 'up' && manualCurrentLine > 0) {
            // When going up, remove complete/read state from the line we're leaving
            const leavingEl = manualLineElements[manualCurrentLine];
            leavingEl.classList.remove('garb-line-complete');
            leavingEl.querySelectorAll('.garb-word-read').forEach(w => {
                w.classList.remove('garb-word-read');
            });
            manualCurrentLine--;
        } else {
            return; // At boundary, do nothing
        }

        highlightManualLine(manualCurrentLine);

        if (dataLogger) {
            dataLogger.logUIEvent('line_switch', {
                old_line: oldLine,
                new_line: manualCurrentLine,
                reason: 'manual_key',
                direction: direction
            });
        }
    }

    /**
     * Reset baseline mode state (for new articles)
     */
    function resetBaselineMode() {
        baselineWordIndex = 0;
        baselineStartTime = 0;
        baselinePausedDuration = 0;
        baselinePauseStartTime = 0;
        baselineWordMap = [];
        baselineTotalWords = 0;
        baselineInitialized = false;
    }

    /**
     * Nudge baseline position forward/backward by lines
     * @param {number} linesDelta - positive = forward, negative = backward
     */
    function nudgeBaselinePosition(linesDelta) {
        if (!baselineInitialized || baselineTotalWords === 0) return;

        // Find current line's word count to estimate nudge amount
        const currentWord = baselineWordMap[baselineWordIndex];
        if (!currentWord) return;

        // Average ~10 words per line, adjust by linesDelta
        const wordsToNudge = linesDelta * 10;
        const newIndex = Math.max(0, Math.min(baselineWordIndex + wordsToNudge, baselineTotalWords - 1));

        // Adjust the start time to match the new position
        // This effectively "jumps" to the new position while keeping the pace
        const wordsPerMs = baselineWPM / 60000;
        const timeForNewPosition = newIndex / wordsPerMs;
        const now = Date.now();

        // Recalculate start time so that current effective time gives us newIndex
        baselineStartTime = now - baselinePausedDuration - timeForNewPosition;
        baselineWordIndex = newIndex;

        console.log(`GARB: Baseline nudged by ${linesDelta} lines, new word index: ${newIndex}`);
    }

    /**
     * Adjust baseline WPM
     * @param {number} newWPM - new words per minute rate
     */
    function setBaselineWPM(newWPM) {
        // Clamp to reasonable range
        newWPM = Math.max(100, Math.min(400, newWPM));

        // Adjust start time to maintain current position at new rate
        if (baselineInitialized && baselineStartTime > 0) {
            const now = Date.now();
            const effectiveTime = now - baselineStartTime - baselinePausedDuration;
            const wordsPerMs = baselineWPM / 60000;
            const currentWordIndex = Math.floor(effectiveTime * wordsPerMs);

            // Recalculate start time for new WPM to keep same position
            const newWordsPerMs = newWPM / 60000;
            const newTimeForPosition = currentWordIndex / newWordsPerMs;
            baselineStartTime = now - baselinePausedDuration - newTimeForPosition;
        }

        baselineWPM = newWPM;
        console.log(`GARB: Baseline WPM set to ${newWPM}`);

        if (dataLogger) {
            dataLogger.logUIEvent('wpm_change', { wpm: newWPM });
        }
    }

    // ========================================
    // PAUSE/LOCK FUNCTIONALITY
    // ========================================

    /**
     * Toggle pause state
     * @param {string} reason - 'manual' or 'tracking_lost'
     */
    function togglePause(reason = 'manual') {
        if (isPaused) {
            resumeTracking(reason);
        } else {
            pauseTracking(reason);
        }
    }

    /**
     * Pause tracking - freeze highlight at current position
     * @param {string} reason - 'manual' or 'tracking_lost'
     */
    function pauseTracking(reason = 'manual') {
        if (isPaused) return;

        isPaused = true;
        pauseReason = reason;

        // Track pause start time for baseline mode
        baselinePauseStartTime = Date.now();

        // Log pause event
        if (dataLogger) {
            dataLogger.logUIEvent('pause_on', {
                reason: reason,
                line: gazeState.lastStablePosition.line,
                word: gazeState.lastStablePosition.word,
                mode: currentTrackingMode,
                baseline_word_index: currentTrackingMode === TRACKING_MODES.BASELINE ? baselineWordIndex : null
            });
        }

        // Update status indicator
        const statusText = reason === 'manual' ? 'Paused (L to resume)' : 'Paused (tracking lost)';
        updateStatusIndicator(statusText, false);

        // Stop baseline interval if running
        if (currentTrackingMode === TRACKING_MODES.BASELINE) {
            stopBaselineMode();
        }

        console.log("GARB: Tracking paused -", reason);
    }

    /**
     * Resume tracking from paused state
     * @param {string} reason - 'manual' or 'tracking_recovered'
     */
    function resumeTracking(reason = 'manual') {
        if (!isPaused) return;

        const wasPausedFor = pauseReason;
        isPaused = false;
        pauseReason = null;

        // Add paused duration to total for baseline mode
        if (baselinePauseStartTime > 0) {
            baselinePausedDuration += Date.now() - baselinePauseStartTime;
            baselinePauseStartTime = 0;
        }

        // Reset tracking lost state and hide overlay
        if (gazeState.trackingLost) {
            gazeState.trackingLost = false;
            hideTrackingLostIndicator();
        }

        // Log resume event
        if (dataLogger) {
            dataLogger.logUIEvent('pause_off', {
                was_paused_for: wasPausedFor,
                resumed_by: reason,
                line: gazeState.lastStablePosition.line,
                word: gazeState.lastStablePosition.word,
                mode: currentTrackingMode,
                baseline_word_index: currentTrackingMode === TRACKING_MODES.BASELINE ? baselineWordIndex : null
            });
        }

        // Update status indicator
        updateStatusIndicator('Eye tracking active', false);

        // Restart baseline interval if in baseline mode
        if (currentTrackingMode === TRACKING_MODES.BASELINE) {
            startBaselineMode();
        }

        console.log("GARB: Tracking resumed -", reason);
    }

    /**
     * Switch tracking mode
     * @param {string} mode - 'gaze', 'baseline', or 'none'
     */
    function setTrackingMode(mode) {
        const oldMode = currentTrackingMode;

        // Skip if already in this mode
        if (oldMode === mode) {
            console.log(`GARB: Already in ${mode} mode, skipping`);
            return;
        }

        currentTrackingMode = mode;
        console.log(`GARB: Switching mode from ${oldMode} to ${mode}`);

        // CRITICAL: Update data-mode attribute FIRST for immediate CSS change
        document.body.dataset.mode = mode;

        // Log mode change
        if (dataLogger) {
            dataLogger.logUIEvent('mode_change', {
                from: oldMode,
                to: mode
            });
        }

        // Stop previous mode
        if (oldMode === TRACKING_MODES.BASELINE) {
            stopBaselineMode();
            baselinePauseStartTime = Date.now();
        } else if (oldMode === TRACKING_MODES.MANUAL) {
            stopManualMode();
        }

        // ALWAYS clear highlights when switching modes (so new colors show)
        clearAllHighlighting();

        // ========================================
        // MODE TRANSITION HANDLING
        // ========================================

        if (mode === TRACKING_MODES.BASELINE) {
            if (oldMode === TRACKING_MODES.GAZE) {
                syncBaselineToGazePosition();
                baselinePauseStartTime = 0;
            } else if (oldMode === TRACKING_MODES.NONE || oldMode === TRACKING_MODES.MANUAL) {
                if (baselinePauseStartTime > 0 && baselineStartTime > 0) {
                    baselinePausedDuration += Date.now() - baselinePauseStartTime;
                    baselinePauseStartTime = 0;
                }
            }
            startBaselineMode();
        } else if (mode === TRACKING_MODES.GAZE) {
            if (oldMode === TRACKING_MODES.BASELINE) {
                syncGazeToBaselinePosition();
            }
        } else if (mode === TRACKING_MODES.MANUAL) {
            startManualMode();
        }

        // Update mode indicator in UI
        updateModeIndicator(mode);
    }

    /**
     * Sync baseline mode position to current gaze position
     * Called when switching from Mode A (Gaze) to Mode B (Baseline)
     */
    function syncBaselineToGazePosition() {
        const currentLine = gazeState.currentLockedLine;
        const currentWord = gazeState.lastStablePosition ? gazeState.lastStablePosition.word : 0;

        console.log(`GARB: Syncing baseline to gaze position - line ${currentLine}, word ${currentWord}`);

        // Ensure baseline word map is built
        if (!baselineInitialized || baselineWordMap.length === 0) {
            buildBaselineWordMap();
        }

        // Find the baseline word index that matches the gaze position
        let targetIndex = 0;
        for (let i = 0; i < baselineWordMap.length; i++) {
            const entry = baselineWordMap[i];
            if (entry.line === currentLine && entry.wordIdx === currentWord) {
                targetIndex = i;
                break;
            }
            // If we pass the current line, use the last word of that line
            if (entry.line > currentLine) {
                targetIndex = Math.max(0, i - 1);
                break;
            }
            // Keep track in case we reach the end
            if (entry.line === currentLine) {
                targetIndex = i;
            }
        }

        baselineWordIndex = targetIndex;
        // Reset the start time accounting for words already "read"
        baselineStartTime = Date.now() - (targetIndex / (baselineWPM / 60) * 1000);
        baselinePausedDuration = 0;

        // Clear all highlights AFTER the current position so Mode B's highlights are visible
        clearHighlightsAfterPosition(currentLine, currentWord);

        console.log(`GARB: Baseline synced to word index ${targetIndex}`);
    }

    /**
     * Clear all word/line highlights after a given position
     * Used when switching from Mode A to Mode B to make B's new highlights visible
     */
    function clearHighlightsAfterPosition(lineNum, wordNum) {
        const lines = document.querySelectorAll('.garb-line');

        for (let i = 0; i < lines.length; i++) {
            const words = lines[i].querySelectorAll('.garb-word');

            if (i < lineNum) {
                // Lines before current - keep all highlights
                continue;
            } else if (i === lineNum) {
                // Current line - clear highlights after current word
                for (let j = wordNum + 1; j < words.length; j++) {
                    words[j].classList.remove('garb-word-read', 'garb-word-current');
                }
            } else {
                // Lines after current - clear all highlights
                lines[i].classList.remove('garb-line-active', 'garb-line-complete');
                for (let j = 0; j < words.length; j++) {
                    words[j].classList.remove('garb-word-read', 'garb-word-current');
                }
            }
        }

        console.log(`GARB: Cleared highlights after line ${lineNum}, word ${wordNum}`);
    }

    /**
     * Sync gaze mode position to current baseline position
     * Called when switching from Mode B (Baseline) to Mode A (Gaze)
     */
    function syncGazeToBaselinePosition() {
        if (!baselineInitialized || baselineWordMap.length === 0 || baselineWordIndex < 0) {
            console.log("GARB: No baseline position to sync from");
            return;
        }

        // Get position from baseline
        const currentEntry = baselineWordMap[Math.min(baselineWordIndex, baselineWordMap.length - 1)];
        if (!currentEntry) return;

        const targetLine = currentEntry.line;
        const targetWord = currentEntry.wordIdx;

        console.log(`GARB: Syncing gaze to baseline position - line ${targetLine}, word ${targetWord}`);

        // Update gaze state to this position
        gazeState.currentLockedLine = targetLine;
        gazeState.lastStablePosition = {
            line: targetLine,
            word: targetWord
        };
        gazeState.lineStartTime = Date.now();
        gazeState.candidateLine = null;
        gazeState.candidateLineStartTime = 0;

        // Update the visual highlighting to this position
        const lines = document.querySelectorAll('.garb-line');
        const targetLineEl = lines[targetLine];

        if (targetLineEl) {
            // Use applyWordHighlighting for consistent visual update
            applyWordHighlighting(targetLineEl, targetLine, targetWord, targetWord);
        }

        // Mark all previous lines and words as read
        for (let i = 0; i < targetLine && i < lines.length; i++) {
            const words = lines[i].querySelectorAll('.garb-word');
            lines[i].classList.add('garb-line-complete');
            lines[i].classList.remove('garb-line-active');
            for (let j = 0; j < words.length; j++) {
                words[j].classList.add('garb-word-read');
            }
        }

        console.log(`GARB: Gaze synced to line ${targetLine}, word ${targetWord}`);
    }

    /**
     * Custom smooth scroll with configurable duration (slower than native smooth)
     * @param {number} deltaY - Amount to scroll (positive = down, negative = up)
     * @param {number} duration - Animation duration in ms
     */
    function smoothScrollBy(deltaY, duration = 400) {
        const startY = window.scrollY;
        const startTime = performance.now();

        function animateScroll(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Ease-out cubic for smooth deceleration
            const easeOut = 1 - Math.pow(1 - progress, 3);
            const currentY = startY + (deltaY * easeOut);

            window.scrollTo(0, currentY);

            if (progress < 1) {
                requestAnimationFrame(animateScroll);
            }
        }

        requestAnimationFrame(animateScroll);
    }

    /**
     * Clear all highlighting (for 'none' mode)
     */
    function clearAllHighlighting() {
        // Remove active line highlighting
        document.querySelectorAll('.garb-line-active').forEach(el => {
            el.classList.remove('garb-line-active');
        });

        // Remove word highlighting (but keep 'read' state for progress tracking)
        document.querySelectorAll('.garb-word-current').forEach(el => {
            el.classList.remove('garb-word-current');
        });

        // Hide gaze bubble
        if (gazeBubble) {
            gazeBubble.style.opacity = '0';
        }
        if (gazeBubbleTrail) {
            gazeBubbleTrail.style.opacity = '0';
        }

        // Reset display state
        displayedCurrentLine = -1;
        displayedCurrentWord = -1;
    }

    /**
     * Clear all reading progress and reset to start fresh
     * Called when user clicks "Clear Progress" button
     */
    function clearReadingProgress() {
        console.log("GARB: Clearing all reading progress");

        // Clear all visual highlights
        document.querySelectorAll('.garb-line-active, .garb-line-complete').forEach(el => {
            el.classList.remove('garb-line-active', 'garb-line-complete');
        });
        document.querySelectorAll('.garb-word-read, .garb-word-current').forEach(el => {
            el.classList.remove('garb-word-read', 'garb-word-current');
        });

        // Reset gaze state
        gazeState.currentLockedLine = -1;
        gazeState.lastStablePosition = { line: 0, word: 0 };
        gazeState.candidateLine = null;
        gazeState.candidateLineStartTime = 0;
        gazeState.lineStartTime = 0;
        gazeState.lastValidGazeTime = Date.now();
        gazeState.trackingLost = false;

        // Reset display state
        displayedCurrentLine = -1;
        displayedCurrentWord = -1;
        lastStableLineNum = -1;
        lastStableWordIdx = -1;
        stabilityCounter = 0;

        // Reset word progress tracking
        wordReadProgress = {};

        // Reset baseline mode state
        baselineWordIndex = 0;
        baselineStartTime = Date.now();
        baselinePausedDuration = 0;
        baselinePauseStartTime = 0;

        // Reset scroll state
        scrollTriggerStartTime = 0;
        scrollUpTriggerStartTime = 0;
        lastScrollTime = 0;

        // Scroll to top of article
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // Log the reset
        if (dataLogger) {
            dataLogger.logUIEvent('progress_cleared', {
                mode: currentTrackingMode
            });
        }

        console.log("GARB: Reading progress cleared - scroll to top");
    }

    /**
     * Update mode indicator in the reader UI
     */
    function updateModeIndicator(mode) {
        let modeText = '';
        switch (mode) {
            case TRACKING_MODES.GAZE:
                modeText = 'Gaze Tracking';
                break;
            case TRACKING_MODES.BASELINE:
                modeText = `Baseline (${baselineWPM} WPM)`;
                break;
            case TRACKING_MODES.MANUAL:
                modeText = 'Manual (↑↓ Keys)';
                break;
            case TRACKING_MODES.NONE:
                modeText = 'No Highlight';
                break;
            default:
                modeText = 'Select Mode';
                break;
        }

        // Update status if there's a mode indicator element
        const modeIndicator = document.querySelector('.garb-mode-indicator');
        if (modeIndicator) {
            modeIndicator.textContent = modeText;
            modeIndicator.className = `garb-mode-indicator garb-mode-${mode || 'none'}`;
        }

        // Update settings panel mode buttons - remove active from all if mode is null
        document.querySelectorAll('.garb-mode-btn-compact').forEach(btn => {
            btn.classList.toggle('active', mode !== null && btn.dataset.mode === mode);
        });
    }

    /**
     * Create the floating gaze bubble elements (main + trail)
     */
    function createGazeBubble() {
        if (gazeBubble) return;

        // Create outer trail bubble (follows slower, creates trailing effect)
        gazeBubbleTrail = document.createElement('div');
        gazeBubbleTrail.className = 'garb-gaze-bubble garb-gaze-trail';
        gazeBubbleTrail.style.cssText = `
            position: fixed;
            pointer-events: none;
            z-index: 9998;
            opacity: 0;
            transition: opacity 0.5s ease;
        `;
        document.body.appendChild(gazeBubbleTrail);

        // Create main bubble (follows gaze more closely)
        gazeBubble = document.createElement('div');
        gazeBubble.className = 'garb-gaze-bubble';
        gazeBubble.style.cssText = `
            position: fixed;
            pointer-events: none;
            z-index: 9999;
            opacity: 0;
            transition: opacity 0.4s ease;
        `;
        document.body.appendChild(gazeBubble);

        // Start the animation loop
        startGazeBubbleAnimation();
    }

    /**
     * Linear interpolation helper
     */
    function lerp(start, end, factor) {
        return start + (end - start) * factor;
    }

    // Fixed circular bubble size for fluid blob effect
    const GAZE_BUBBLE_SIZE = 90; // Main bubble diameter
    const GAZE_BUBBLE_TRAIL_SIZE = 120; // Trail bubble diameter

    /**
     * Animate the gaze bubble smoothly toward target position with trail effect
     */
    function animateGazeBubble() {
        if (!gazeBubble) return;

        // Recalculate target position from word element (handles scrolling)
        let targetX = gazeBubbleCurrent.x;
        let targetY = gazeBubbleCurrent.y;

        if (gazeBubbleTargetWord && document.contains(gazeBubbleTargetWord)) {
            const rect = gazeBubbleTargetWord.getBoundingClientRect();
            // Center the bubble on the word
            const wordCenterX = rect.left + rect.width / 2;
            const wordCenterY = rect.top + rect.height / 2;
            // Position bubble so its center aligns with word center
            targetX = wordCenterX - GAZE_BUBBLE_SIZE / 2;
            targetY = wordCenterY - GAZE_BUBBLE_SIZE / 2;
        }

        // Smooth interpolation for main bubble position (fixed size, fluid movement)
        gazeBubbleCurrent.x = lerp(gazeBubbleCurrent.x, targetX, GAZE_BUBBLE_LERP_SPEED);
        gazeBubbleCurrent.y = lerp(gazeBubbleCurrent.y, targetY, GAZE_BUBBLE_LERP_SPEED);

        // Trail follows the main bubble center (even slower for flowing trail effect)
        const mainCenterX = gazeBubbleCurrent.x + GAZE_BUBBLE_SIZE / 2;
        const mainCenterY = gazeBubbleCurrent.y + GAZE_BUBBLE_SIZE / 2;
        const trailTargetX = mainCenterX - GAZE_BUBBLE_TRAIL_SIZE / 2;
        const trailTargetY = mainCenterY - GAZE_BUBBLE_TRAIL_SIZE / 2;
        gazeBubbleTrailPos.x = lerp(gazeBubbleTrailPos.x, trailTargetX, GAZE_BUBBLE_TRAIL_SPEED);
        gazeBubbleTrailPos.y = lerp(gazeBubbleTrailPos.y, trailTargetY, GAZE_BUBBLE_TRAIL_SPEED);

        // Apply position to main bubble (fixed circular size)
        gazeBubble.style.left = `${gazeBubbleCurrent.x}px`;
        gazeBubble.style.top = `${gazeBubbleCurrent.y}px`;
        gazeBubble.style.width = `${GAZE_BUBBLE_SIZE}px`;
        gazeBubble.style.height = `${GAZE_BUBBLE_SIZE}px`;

        // Apply position to trail bubble (larger, follows behind)
        if (gazeBubbleTrail) {
            gazeBubbleTrail.style.left = `${gazeBubbleTrailPos.x}px`;
            gazeBubbleTrail.style.top = `${gazeBubbleTrailPos.y}px`;
            gazeBubbleTrail.style.width = `${GAZE_BUBBLE_TRAIL_SIZE}px`;
            gazeBubbleTrail.style.height = `${GAZE_BUBBLE_TRAIL_SIZE}px`;
        }

        // Continue animation loop
        gazeBubbleAnimationFrame = requestAnimationFrame(animateGazeBubble);
    }

    /**
     * Start the gaze bubble animation loop
     */
    function startGazeBubbleAnimation() {
        if (gazeBubbleAnimationFrame) {
            cancelAnimationFrame(gazeBubbleAnimationFrame);
        }
        gazeBubbleAnimationFrame = requestAnimationFrame(animateGazeBubble);
    }

    /**
     * Update the gaze bubble target to a word element
     */
    function updateGazeBubbleTarget(wordEl) {
        if (!wordEl || !gazeBubble) return;

        // Store reference to target word for continuous position updates
        gazeBubbleTargetWord = wordEl;

        // Initialize current position on first update (center on word)
        if (gazeBubbleCurrent.x === 0 && gazeBubbleCurrent.y === 0) {
            const rect = wordEl.getBoundingClientRect();
            const wordCenterX = rect.left + rect.width / 2;
            const wordCenterY = rect.top + rect.height / 2;
            gazeBubbleCurrent.x = wordCenterX - GAZE_BUBBLE_SIZE / 2;
            gazeBubbleCurrent.y = wordCenterY - GAZE_BUBBLE_SIZE / 2;
            // Initialize trail at same center position
            gazeBubbleTrailPos.x = wordCenterX - GAZE_BUBBLE_TRAIL_SIZE / 2;
            gazeBubbleTrailPos.y = wordCenterY - GAZE_BUBBLE_TRAIL_SIZE / 2;
        }

        // Show both bubbles
        gazeBubble.style.opacity = '1';
        if (gazeBubbleTrail) {
            gazeBubbleTrail.style.opacity = '1';
        }
    }

    // Track the currently active line to clear it when switching
    let currentActiveLineEl = null;

    /**
     * Clear active highlighting from all lines except the current one
     */
    function clearOtherActiveLines(exceptLineNum) {
        const activeLines = document.querySelectorAll('.garb-line-active');
        activeLines.forEach(line => {
            const num = parseInt(line.dataset.line);
            if (num !== exceptLineNum) {
                line.classList.remove('garb-line-active');
            }
        });
    }

    /**
     * Apply word-by-word highlighting
     * @param {Element} lineEl - The line element
     * @param {number} lineNum - Line number
     * @param {number} readUpToWordIdx - Words read up to this index get "read" highlight
     * @param {number} currentWordIdx - The current gaze position (optional, for current indicator)
     */
    function applyWordHighlighting(lineEl, lineNum, readUpToWordIdx, currentWordIdx) {
        const words = lineEl.querySelectorAll('.garb-word');
        const totalWords = words.length;

        // Use readUpToWordIdx as current if not specified
        if (currentWordIdx === undefined) {
            currentWordIdx = readUpToWordIdx;
        }

        // Clear active highlighting from other lines - only one line should be active at a time
        clearOtherActiveLines(lineNum);

        // Update current active line reference
        if (currentActiveLineEl && currentActiveLineEl !== lineEl) {
            // Remove active from old line (unless it's complete)
            if (!currentActiveLineEl.classList.contains('garb-line-complete')) {
                currentActiveLineEl.classList.remove('garb-line-active');
            }
        }
        currentActiveLineEl = lineEl;

        words.forEach((wordEl, idx) => {
            if (idx <= readUpToWordIdx) {
                wordEl.classList.add('garb-word-read');
            }

            // Update floating gaze bubble position for current word
            if (idx === currentWordIdx) {
                updateGazeBubbleTarget(wordEl);
            }
        });

        if (readUpToWordIdx >= 0) {
            lineEl.classList.add('garb-line-active');
        }

        if (readUpToWordIdx >= totalWords - 1) {
            lineEl.classList.add('garb-line-complete');
            lineEl.classList.remove('garb-line-active');
        }
    }

    // ========================================
    // SURVEY MODAL FOR SUBJECTIVE MEASURES
    // ========================================

    /**
     * NASA-TLX Questions
     */
    const NASA_TLX_QUESTIONS = [
        {
            id: 'mental_demand',
            label: 'Mental Demand',
            description: 'How mentally demanding was the task?',
            lowLabel: 'Very Low',
            highLabel: 'Very High'
        },
        {
            id: 'physical_demand',
            label: 'Physical Demand',
            description: 'How physically demanding was the task?',
            lowLabel: 'Very Low',
            highLabel: 'Very High'
        },
        {
            id: 'temporal_demand',
            label: 'Temporal Demand',
            description: 'How hurried or rushed was the pace of the task?',
            lowLabel: 'Very Low',
            highLabel: 'Very High'
        },
        {
            id: 'performance',
            label: 'Performance',
            description: 'How successful were you in accomplishing what you were asked to do?',
            lowLabel: 'Perfect',
            highLabel: 'Failure'
        },
        {
            id: 'effort',
            label: 'Effort',
            description: 'How hard did you have to work to accomplish your level of performance?',
            lowLabel: 'Very Low',
            highLabel: 'Very High'
        },
        {
            id: 'frustration',
            label: 'Frustration',
            description: 'How insecure, discouraged, irritated, stressed, and annoyed were you?',
            lowLabel: 'Very Low',
            highLabel: 'Very High'
        }
    ];

    /**
     * SUS Questions (System Usability Scale)
     */
    const SUS_QUESTIONS = [
        'I think that I would like to use GARB frequently.',
        'I found GARB unnecessarily complex.',
        'I thought GARB was easy to use.',
        'I think that I would need the support of a technical person to use GARB.',
        'I found the various functions in GARB were well integrated.',
        'I thought there was too much inconsistency in GARB.',
        'I would imagine that most people would learn to use GARB very quickly.',
        'I found GARB very cumbersome to use.',
        'I felt very confident using GARB.',
        'I needed to learn a lot of things before I could get going with GARB.'
    ];

    /**
     * Custom GARB Scale Questions
     */
    const GARB_CUSTOM_QUESTIONS = [
        { id: 'helped_keep_place', text: 'The highlighting helped me keep my place while reading.' },
        { id: 'reduced_rereading', text: 'I had to re-read less often with the eye tracking active.' },
        { id: 'felt_natural', text: 'The tracking felt natural and unobtrusive.' },
        { id: 'tracking_accuracy', text: 'The tracking accurately followed where I was reading.' },
        { id: 'would_use_again', text: 'I would use this extension again for reading.' }
    ];

    // Survey state
    let surveyModal = null;
    let surveyResponses = {
        nasa_tlx: {},
        sus: { responses: [] },
        custom_garb: {}
    };
    let currentSurveySection = 0;
    let currentQuestionIndex = 0;

    /**
     * Open the survey modal
     */
    function openSurveyModal() {
        if (surveyModal) return;

        // Reset survey state
        surveyResponses = {
            nasa_tlx: {},
            sus: { responses: new Array(10).fill(null) },
            custom_garb: {}
        };
        currentSurveySection = 0;
        currentQuestionIndex = 0;

        // Create modal overlay
        surveyModal = document.createElement('div');
        surveyModal.className = 'garb-modal-overlay';

        renderSurveyContent();
        document.body.appendChild(surveyModal);
    }

    /**
     * Close the survey modal
     */
    function closeSurveyModal() {
        if (surveyModal) {
            surveyModal.remove();
            surveyModal = null;
        }
    }

    /**
     * Render current survey content
     */
    function renderSurveyContent() {
        if (!surveyModal) return;

        let content = '';
        let title = '';
        let subtitle = '';
        let totalQuestions = 0;
        let currentQuestion = 0;

        if (currentSurveySection === 0) {
            // NASA-TLX
            title = 'NASA Task Load Index';
            subtitle = 'Rate your experience on each dimension';
            totalQuestions = NASA_TLX_QUESTIONS.length;
            currentQuestion = currentQuestionIndex + 1;

            const q = NASA_TLX_QUESTIONS[currentQuestionIndex];
            const currentValue = surveyResponses.nasa_tlx[q.id] || 50;

            content = `
                <div class="garb-survey-question">
                    <p class="garb-survey-prompt">${q.description}</p>
                    <div class="garb-tlx-scale">
                        <input type="range" class="garb-tlx-slider" id="tlx-slider"
                            min="0" max="100" step="5" value="${currentValue}">
                        <div class="garb-tlx-value" id="tlx-value">${currentValue}</div>
                        <div class="garb-tlx-labels">
                            <span>${q.lowLabel}</span>
                            <span>${q.highLabel}</span>
                        </div>
                    </div>
                </div>
            `;
        } else if (currentSurveySection === 1) {
            // SUS
            title = 'System Usability Scale';
            subtitle = 'Rate your agreement with each statement';
            totalQuestions = SUS_QUESTIONS.length;
            currentQuestion = currentQuestionIndex + 1;

            const questionText = SUS_QUESTIONS[currentQuestionIndex];
            const currentValue = surveyResponses.sus.responses[currentQuestionIndex];

            content = `
                <div class="garb-survey-question">
                    <p class="garb-survey-prompt">${questionText}</p>
                    <div class="garb-likert-scale">
                        ${[1,2,3,4,5].map(n => `
                            <label class="garb-likert-option">
                                <input type="radio" name="sus-q" value="${n}" ${currentValue === n ? 'checked' : ''}>
                                <div class="garb-likert-circle">${n}</div>
                            </label>
                        `).join('')}
                    </div>
                    <div class="garb-likert-labels">
                        <span>Strongly Disagree</span>
                        <span>Strongly Agree</span>
                    </div>
                </div>
            `;
        } else if (currentSurveySection === 2) {
            // Custom GARB Scale
            title = 'Reading Experience';
            subtitle = 'Rate your agreement with each statement';
            totalQuestions = GARB_CUSTOM_QUESTIONS.length;
            currentQuestion = currentQuestionIndex + 1;

            const q = GARB_CUSTOM_QUESTIONS[currentQuestionIndex];
            const currentValue = surveyResponses.custom_garb[q.id];

            content = `
                <div class="garb-survey-question">
                    <p class="garb-survey-prompt">${q.text}</p>
                    <div class="garb-likert-scale">
                        ${[1,2,3,4,5,6,7].map(n => `
                            <label class="garb-likert-option">
                                <input type="radio" name="garb-q" value="${n}" ${currentValue === n ? 'checked' : ''}>
                                <div class="garb-likert-circle">${n}</div>
                            </label>
                        `).join('')}
                    </div>
                    <div class="garb-likert-labels">
                        <span>Strongly Disagree</span>
                        <span>Strongly Agree</span>
                    </div>
                </div>
            `;
        } else {
            // Survey complete
            title = 'Thank You!';
            subtitle = 'Your responses have been recorded';

            content = `
                <div style="text-align: center; padding: 40px 0;">
                    <div style="font-size: 48px; margin-bottom: 20px;">✓</div>
                    <p style="color: var(--text-muted);">Your feedback helps improve GARB for future users.</p>
                </div>
            `;
        }

        // Calculate overall progress
        const totalAll = NASA_TLX_QUESTIONS.length + SUS_QUESTIONS.length + GARB_CUSTOM_QUESTIONS.length;
        let completedAll = Object.keys(surveyResponses.nasa_tlx).length +
                          surveyResponses.sus.responses.filter(v => v !== null).length +
                          Object.keys(surveyResponses.custom_garb).length;
        const progressPercent = Math.round((completedAll / totalAll) * 100);

        surveyModal.innerHTML = `
            <div class="garb-modal">
                <div class="garb-modal-header">
                    <h2 class="garb-modal-title">${title}</h2>
                    <p class="garb-modal-subtitle">${subtitle}</p>
                </div>
                <div class="garb-modal-body">
                    ${content}
                </div>
                <div class="garb-modal-footer">
                    <div class="garb-survey-progress">
                        <div class="garb-survey-progress-bar">
                            <div class="garb-survey-progress-fill" style="width: ${progressPercent}%"></div>
                        </div>
                        <span>${progressPercent}% complete</span>
                    </div>
                    <div>
                        ${currentSurveySection < 3 ? `
                            <button class="garb-btn garb-btn-primary" id="survey-next">
                                ${currentSurveySection === 2 && currentQuestionIndex === GARB_CUSTOM_QUESTIONS.length - 1 ? 'Finish' : 'Next'}
                            </button>
                        ` : `
                            <button class="garb-btn garb-btn-primary" id="survey-close">Close</button>
                        `}
                    </div>
                </div>
            </div>
        `;

        // Add event listeners
        setTimeout(() => {
            // TLX slider
            const tlxSlider = surveyModal.querySelector('#tlx-slider');
            if (tlxSlider) {
                tlxSlider.addEventListener('input', (e) => {
                    const value = e.target.value;
                    surveyModal.querySelector('#tlx-value').textContent = value;
                    surveyResponses.nasa_tlx[NASA_TLX_QUESTIONS[currentQuestionIndex].id] = parseInt(value);
                });
            }

            // SUS radio buttons
            const susRadios = surveyModal.querySelectorAll('input[name="sus-q"]');
            susRadios.forEach(radio => {
                radio.addEventListener('change', (e) => {
                    surveyResponses.sus.responses[currentQuestionIndex] = parseInt(e.target.value);
                });
            });

            // Custom GARB radio buttons
            const garbRadios = surveyModal.querySelectorAll('input[name="garb-q"]');
            garbRadios.forEach(radio => {
                radio.addEventListener('change', (e) => {
                    surveyResponses.custom_garb[GARB_CUSTOM_QUESTIONS[currentQuestionIndex].id] = parseInt(e.target.value);
                });
            });

            // Next button
            const nextBtn = surveyModal.querySelector('#survey-next');
            if (nextBtn) {
                nextBtn.addEventListener('click', handleSurveyNext);
            }

            // Close button
            const closeBtn = surveyModal.querySelector('#survey-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', () => {
                    saveSurveyResponses();
                    closeSurveyModal();
                });
            }
        }, 0);
    }

    /**
     * Handle next button click in survey
     */
    function handleSurveyNext() {
        // Save current response if NASA-TLX (slider has default)
        if (currentSurveySection === 0) {
            const q = NASA_TLX_QUESTIONS[currentQuestionIndex];
            if (!surveyResponses.nasa_tlx[q.id]) {
                surveyResponses.nasa_tlx[q.id] = 50; // Default to middle
            }
        }

        // Advance to next question
        if (currentSurveySection === 0) {
            if (currentQuestionIndex < NASA_TLX_QUESTIONS.length - 1) {
                currentQuestionIndex++;
            } else {
                currentSurveySection = 1;
                currentQuestionIndex = 0;
            }
        } else if (currentSurveySection === 1) {
            if (currentQuestionIndex < SUS_QUESTIONS.length - 1) {
                currentQuestionIndex++;
            } else {
                currentSurveySection = 2;
                currentQuestionIndex = 0;
            }
        } else if (currentSurveySection === 2) {
            if (currentQuestionIndex < GARB_CUSTOM_QUESTIONS.length - 1) {
                currentQuestionIndex++;
            } else {
                currentSurveySection = 3; // Complete
                saveSurveyResponses();
            }
        }

        renderSurveyContent();
    }

    /**
     * Calculate SUS score (0-100)
     */
    function calculateSUSScore(responses) {
        if (responses.length !== 10 || responses.some(r => r === null)) {
            return null;
        }

        let score = 0;
        for (let i = 0; i < 10; i++) {
            if (i % 2 === 0) {
                // Odd items (1,3,5,7,9 in 1-indexed) - positive
                score += responses[i] - 1;
            } else {
                // Even items (2,4,6,8,10 in 1-indexed) - negative
                score += 5 - responses[i];
            }
        }
        return score * 2.5;
    }

    /**
     * Calculate NASA-TLX raw score
     */
    function calculateNASATLXScore(responses) {
        const values = Object.values(responses);
        if (values.length !== 6) return null;
        return Math.round(values.reduce((a, b) => a + b, 0) / 6);
    }

    /**
     * Save survey responses to the session
     */
    function saveSurveyResponses() {
        // Calculate scores
        surveyResponses.nasa_tlx.raw_score = calculateNASATLXScore(surveyResponses.nasa_tlx);
        surveyResponses.sus.score = calculateSUSScore(surveyResponses.sus.responses);

        // Send to background script for saving
        safeSendMessage({
            contentScriptQuery: 'saveSurveyResponses',
            data: {
                user: window.currentUser,
                url: window.targetSiteURL,
                survey_responses: surveyResponses,
                survey_completed_at: Date.now()
            }
        });

        console.log('Survey responses saved:', surveyResponses);
    }

    // Listen for survey trigger from popup
    try {
        chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
            if (request.action === 'openSurvey') {
                openSurveyModal();
                sendResponse({ success: true });
            }
            return true;
        });
    } catch (e) {
        // Extension context may be invalid
    }

    // Expose survey function globally for testing
    window.openGARBSurvey = openSurveyModal;

})();
