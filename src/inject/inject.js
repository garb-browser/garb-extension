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

    // Stabilization for smooth tracking
    let lastStableLineNum = -1;
    let lastStableWordIdx = -1;
    let stabilityCounter = 0;
    const STABILITY_THRESHOLD = 4; // Gaze samples needed before changing position (increased)
    let lastScrollTime = 0;
    const SCROLL_COOLDOWN = 600; // ms between auto-scrolls (reduced for smoother scrolling)
    let targetScrollY = 0; // For smooth interpolated scrolling
    let scrollAnimationFrame = null;

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
                    runInjection();
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

                // Handle mode switching
                if (request.switchMode && isActivated) {
                    console.log("Mode switched to:", request.switchMode);
                    window.eyeTrackingViewMode = request.switchMode;
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
            <button class="garb-settings-toggle" id="garb-settings-toggle" title="Reader Settings">Aa</button>
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
        const SIZE_CLASSES = ['size-small', 'size-medium'];
        const panel = document.getElementById('garb-settings-panel');

        // Close panel when clicking outside
        if (panel) {
            document.addEventListener('click', (e) => {
                const toggleBtn = document.getElementById('garb-settings-toggle');
                if (!panel.contains(e.target) && e.target !== toggleBtn && !e.target.closest('.garb-settings-toggle')) {
                    panel.classList.remove('visible');
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

        // Auto-scroll toggle
        const autoscrollCheckbox = document.getElementById('garb-autoscroll-checkbox');
        if (autoscrollCheckbox) {
            autoscrollCheckbox.addEventListener('change', function() {
                autoScrollEnabled = this.checked;
                try {
                    localStorage.setItem('garb-autoscroll', autoScrollEnabled ? 'true' : 'false');
                } catch (e) {}
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

        // Settings panel HTML (integrated into status bar)
        const settingsPanel = `
            <div class="garb-settings-panel" id="garb-settings-panel">
                <div class="garb-settings-section">
                    <span class="garb-settings-label">Background</span>
                    <div class="garb-theme-options">
                        <button class="garb-theme-btn theme-white-btn" data-theme="white" title="White"></button>
                        <button class="garb-theme-btn theme-gray-btn active" data-theme="gray" title="Gray"></button>
                        <button class="garb-theme-btn theme-cream-btn" data-theme="cream" title="Sepia"></button>
                        <button class="garb-theme-btn theme-dark-btn" data-theme="dark" title="Dark"></button>
                    </div>
                </div>
                <div class="garb-settings-section">
                    <span class="garb-settings-label">Font</span>
                    <div class="garb-font-options">
                        <button class="garb-font-btn active" data-font="serif" title="Serif">Serif</button>
                        <button class="garb-font-btn" data-font="sans" title="Sans-serif">Sans</button>
                        <button class="garb-font-btn" data-font="sf" title="San Francisco">SF</button>
                        <button class="garb-font-btn" data-font="system" title="System">System</button>
                        <button class="garb-font-btn" data-font="dyslexic" title="OpenDyslexic">Dyslexic</button>
                    </div>
                </div>
                <div class="garb-settings-section">
                    <span class="garb-settings-label">Size</span>
                    <div class="garb-size-options">
                        <button class="garb-size-btn" data-size="small" title="Smaller text">A</button>
                        <button class="garb-size-btn active" data-size="medium" title="Larger text">A</button>
                    </div>
                </div>
                <div class="garb-settings-section">
                    <span class="garb-settings-label">Reading</span>
                    <div class="garb-autoscroll-toggle">
                        <span class="garb-autoscroll-label">Auto-scroll</span>
                        <label class="garb-toggle-switch">
                            <input type="checkbox" id="garb-autoscroll-checkbox">
                            <span class="garb-toggle-slider"></span>
                        </label>
                    </div>
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
<body class="garb-reader theme-gray font-serif size-medium">
    ${progressBar}
    ${sourceBar}
    ${settingsPanel}
    <main class="garb-main">
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
    </main>
</body>
</html>`;

        document.documentElement.innerHTML = newPage;

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

                const pageSessionData = {
                    url: window.targetSiteURL,
                    title: document.querySelector('.garb-title')?.textContent || 'Unknown',
                    user: userData.user,
                    timestampStart: Date.now(),
                    timestampEnd: null,
                    sessionClosed: false,
                    quadFreqs: null
                };

                runWebSocket(quadFreqs, dbQuadFreqs, pageSessionData);
            }
        );
    }

    function runWebSocket(quadFreqs, dbQuadFreqs, pageSessionData) {
        window.startTime = Date.now();

        if ("WebSocket" in window) {
            updateStatusIndicator("Connecting to eye tracker...");

            tryConnect("ws://127.0.0.1:8765/hello", quadFreqs, dbQuadFreqs)
                .catch(() => tryConnect("ws://[::1]:8765/hello", quadFreqs, dbQuadFreqs))
                .catch(() => tryConnect("ws://localhost:8765/hello", quadFreqs, dbQuadFreqs))
                .then(() => {
                    updateStatusIndicator("Eye tracking active");
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
            const totalTime = Math.floor((Date.now() - window.startTime) / 1000);

            pageSessionData.timestampEnd = Date.now();
            pageSessionData.quadFreqs = quadFreqs;
            pageSessionData.sessionClosed = true;

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
                resolve(ws);
            };

            ws.onerror = function(error) {
                clearTimeout(connectionTimeout);
                reject(error);
            };

            ws.onmessage = createMessageHandler(ws, quadFreqs, dbQuadFreqs);

            ws.onclose = function(event) {
                clearTimeout(connectionTimeout);
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

                const coords = screenToViewport(screenX, screenY);
                const smoothed = smoothGaze(coords.x, coords.y);
                processGaze(ws, quadFreqs, dbQuadFreqs, smoothed.x, smoothed.y);

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
     * Convert screen coordinates to viewport coordinates
     */
    function screenToViewport(screenX, screenY) {
        // Calculate browser chrome (toolbars, address bar, etc.)
        const horizontalChrome = window.outerWidth - window.innerWidth;
        const verticalChrome = window.outerHeight - window.innerHeight;

        // Left offset is typically half the horizontal chrome (for borders/scrollbars)
        const leftOffset = Math.max(0, horizontalChrome / 2);
        // Top offset is the full vertical chrome (toolbars at top)
        const topOffset = Math.max(0, verticalChrome);

        // Convert to viewport coordinates with calibration offset
        const viewportX = screenX - window.screenX - leftOffset + GAZE_X_OFFSET;
        const viewportY = screenY - window.screenY - topOffset + GAZE_Y_OFFSET;

        return { x: viewportX, y: viewportY };
    }

    // Gaze smoothing buffer - balanced for stability and responsiveness
    const gazeHistory = [];
    const GAZE_HISTORY_SIZE = 5;

    /**
     * Smooth gaze coordinates to reduce jitter while maintaining responsiveness
     */
    function smoothGaze(x, y) {
        gazeHistory.push({ x, y, time: Date.now() });

        // Keep only recent samples
        while (gazeHistory.length > GAZE_HISTORY_SIZE) {
            gazeHistory.shift();
        }

        // Remove samples older than 150ms
        const now = Date.now();
        while (gazeHistory.length > 0 && now - gazeHistory[0].time > 150) {
            gazeHistory.shift();
        }

        if (gazeHistory.length === 0) {
            return { x, y };
        }

        // Median filter for X (more robust to outliers than average)
        const xValues = gazeHistory.map(p => p.x).sort((a, b) => a - b);
        const yValues = gazeHistory.map(p => p.y).sort((a, b) => a - b);

        const midIdx = Math.floor(xValues.length / 2);
        let smoothX, smoothY;

        if (xValues.length % 2 === 0) {
            smoothX = (xValues[midIdx - 1] + xValues[midIdx]) / 2;
            smoothY = (yValues[midIdx - 1] + yValues[midIdx]) / 2;
        } else {
            smoothX = xValues[midIdx];
            smoothY = yValues[midIdx];
        }

        // Blend median with most recent for responsiveness (70% median, 30% latest)
        const latest = gazeHistory[gazeHistory.length - 1];
        smoothX = smoothX * 0.7 + latest.x * 0.3;
        smoothY = smoothY * 0.7 + latest.y * 0.3;

        return { x: smoothX, y: smoothY };
    }

    /**
     * Process gaze data and update word-by-word highlighting
     * Uses stabilization to prevent jitter
     */
    function processGaze(ws, quadFreqs, dbQuadFreqs, x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return;

        let lineEl = null;
        let wordEl = null;

        if (el.classList.contains('garb-word')) {
            wordEl = el;
            lineEl = el.parentElement;
            // Handle case where word is inside a link
            if (!lineEl || !lineEl.classList.contains('garb-line')) {
                lineEl = el.closest('.garb-line');
            }
        } else if (el.classList.contains('garb-line')) {
            lineEl = el;
        } else {
            wordEl = el.closest('.garb-word');
            lineEl = el.closest('.garb-line');
        }

        if (!lineEl) return;

        const lineNum = parseInt(lineEl.dataset.line);
        if (isNaN(lineNum) || lineNum < 0 || lineNum >= quadFreqs.length) return;

        if (wordReadProgress[lineNum] === undefined) {
            wordReadProgress[lineNum] = -1;
        }

        let rawWordIdx = -1;
        if (wordEl) {
            rawWordIdx = parseInt(wordEl.dataset.word);
        } else {
            // Improved accuracy: find closest word by position
            const words = lineEl.querySelectorAll('.garb-word');
            let closestWord = null;
            let closestDist = Infinity;

            words.forEach((w, idx) => {
                const rect = w.getBoundingClientRect();
                const centerX = rect.left + rect.width / 2;
                const dist = Math.abs(x - centerX);
                if (dist < closestDist) {
                    closestDist = dist;
                    closestWord = idx;
                }
            });

            rawWordIdx = closestWord !== null ? closestWord : 0;
        }

        // Stabilization: Only update current position if gaze stays consistent
        let stableWordIdx = lastStableWordIdx;
        let stableLineNum = lastStableLineNum;

        if (lineNum === lastStableLineNum && rawWordIdx === lastStableWordIdx) {
            // Same position, increase stability
            stabilityCounter = Math.min(stabilityCounter + 1, STABILITY_THRESHOLD + 5);
        } else if (lineNum === lastStableLineNum && Math.abs(rawWordIdx - lastStableWordIdx) <= 1) {
            // Adjacent word on same line - allow with lower threshold
            stabilityCounter++;
            if (stabilityCounter >= 2) {
                stableWordIdx = rawWordIdx;
                lastStableWordIdx = rawWordIdx;
                stabilityCounter = STABILITY_THRESHOLD;
            }
        } else if (lineNum !== lastStableLineNum) {
            // Different line - require more stability
            stabilityCounter++;
            if (stabilityCounter >= STABILITY_THRESHOLD) {
                stableLineNum = lineNum;
                stableWordIdx = rawWordIdx;
                lastStableLineNum = lineNum;
                lastStableWordIdx = rawWordIdx;
                stabilityCounter = STABILITY_THRESHOLD;
            }
        } else {
            // Same line but jumped multiple words - be cautious
            stabilityCounter = Math.max(0, stabilityCounter - 1);
            if (stabilityCounter <= 0) {
                stableWordIdx = rawWordIdx;
                lastStableWordIdx = rawWordIdx;
                stabilityCounter = 1;
            }
        }

        // Initialize if first run
        if (lastStableLineNum === -1) {
            lastStableLineNum = lineNum;
            lastStableWordIdx = rawWordIdx;
            stableLineNum = lineNum;
            stableWordIdx = rawWordIdx;
        }

        // Progressive fill - only advance reading progress, never go back
        if (stableWordIdx > wordReadProgress[stableLineNum]) {
            const newWordsRead = stableWordIdx - wordReadProgress[stableLineNum];
            wordsRead += newWordsRead;
            wordReadProgress[stableLineNum] = stableWordIdx;
            updateReadingProgress();
        }

        // Apply highlighting with stable position
        const stableLineEl = document.querySelector(`.garb-line[data-line="${stableLineNum}"]`);
        if (stableLineEl) {
            // Additional stabilization for current indicator display
            const now = Date.now();
            let indicatorWordIdx = stableWordIdx;
            let indicatorLineNum = stableLineNum;

            // Only update indicator if enough time has passed or position changed significantly
            const shouldUpdateIndicator = (now - lastIndicatorChangeTime > INDICATOR_MIN_DELAY) ||
                (stableLineNum !== displayedCurrentLine) ||
                (Math.abs(stableWordIdx - displayedCurrentWord) > 2);

            if (shouldUpdateIndicator) {
                displayedCurrentLine = stableLineNum;
                displayedCurrentWord = stableWordIdx;
                lastIndicatorChangeTime = now;
            } else {
                // Keep the old indicator position
                indicatorWordIdx = displayedCurrentWord;
                indicatorLineNum = displayedCurrentLine;
            }

            applyWordHighlighting(stableLineEl, stableLineNum, wordReadProgress[stableLineNum], indicatorWordIdx);
        }

        // Smooth auto-scroll - keeps reading position in comfortable zone
        if (autoScrollEnabled && stableLineEl) {
            const now = Date.now();
            if (now - lastScrollTime > SCROLL_COOLDOWN) {
                const rect = stableLineEl.getBoundingClientRect();
                const viewportHeight = window.innerHeight;

                // Comfort zone: keep current line between 30% and 55% of viewport
                const topThreshold = viewportHeight * 0.30;
                const bottomThreshold = viewportHeight * 0.55;

                if (rect.top < topThreshold || rect.bottom > bottomThreshold) {
                    // Target: position line at 40% from top for comfortable reading
                    const targetPosition = viewportHeight * 0.40;
                    const scrollAmount = rect.top - targetPosition;

                    // Only scroll if the adjustment is meaningful (> 20px)
                    if (Math.abs(scrollAmount) > 20) {
                        // Cancel any pending scroll animation
                        if (scrollAnimationFrame) {
                            cancelAnimationFrame(scrollAnimationFrame);
                        }

                        // Use smaller incremental scrolls for smoother motion
                        const maxScrollPerFrame = 150; // Cap scroll speed
                        const clampedScroll = Math.sign(scrollAmount) * Math.min(Math.abs(scrollAmount), maxScrollPerFrame);

                        targetScrollY = window.scrollY + scrollAmount;

                        // Smooth scroll with easing
                        window.scrollBy({
                            top: clampedScroll,
                            behavior: 'smooth'
                        });

                        lastScrollTime = now;
                    }
                }
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

        // Create gaze bubble if it doesn't exist
        // if (!gazeBubble) {
        //     createGazeBubble();
        // }

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

})();
