// GARB Extension Settings Controller

// Default settings values
const GARB_DEFAULTS = {
    // Appearance
    highlightColor: 'blue',
    customColorEnabled: false,
    customColor: '#3b82f6',
    highlightOpacity: 25,
    lineHighlightEnabled: true,
    showGazeIndicator: true,
    gazeIndicatorSize: 40,

    // Tracking
    gazeYOffset: 0,
    gazeXOffset: 0,
    lineLockTime: 250,
    lineLockMargin: 40,

    // Behavior
    autoScrollEnabled: true,
    autoScrollSpeed: 100,
    scrollMargin: 100,
    trackingLostThreshold: 2000,
    showResumeMarker: true,

    // Advanced
    smoothingAlpha: 0.3,
    fixationVelocityThreshold: 30,
    fixationMinDuration: 100
};

// Load settings from storage and apply to FancySettings
async function loadSettings(settings) {
    try {
        const stored = await chrome.storage.sync.get(Object.keys(GARB_DEFAULTS));

        // Apply stored values or defaults to each setting
        for (const [key, defaultValue] of Object.entries(GARB_DEFAULTS)) {
            const value = stored[key] !== undefined ? stored[key] : defaultValue;

            if (settings.manifest[key]) {
                settings.manifest[key].set(value);
            }
        }

        console.log("GARB settings loaded:", stored);
    } catch (error) {
        console.error("Error loading settings:", error);
    }
}

// Save a setting to storage
async function saveSetting(name, value) {
    try {
        await chrome.storage.sync.set({ [name]: value });
        console.log(`Setting saved: ${name} = ${value}`);

        // Notify all tabs about the settings change
        notifySettingsChanged();
    } catch (error) {
        console.error("Error saving setting:", error);
    }
}

// Notify all tabs that settings have changed
async function notifySettingsChanged() {
    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            try {
                await chrome.tabs.sendMessage(tab.id, { action: "settingsChanged" });
            } catch (e) {
                // Tab might not have content script loaded, that's OK
            }
        }
    } catch (error) {
        console.error("Error notifying tabs:", error);
    }
}

// Reset all settings to defaults
async function resetToDefaults(settings) {
    try {
        // Clear all stored settings
        await chrome.storage.sync.clear();

        // Apply defaults to UI
        for (const [key, value] of Object.entries(GARB_DEFAULTS)) {
            if (settings.manifest[key]) {
                settings.manifest[key].set(value);
            }
        }

        // Save all defaults
        await chrome.storage.sync.set(GARB_DEFAULTS);

        // Notify tabs
        notifySettingsChanged();

        console.log("Settings reset to defaults");
    } catch (error) {
        console.error("Error resetting settings:", error);
    }
}

// Initialize when DOM is ready
window.addEvent("domready", function () {
    new FancySettings.initWithManifest(function (settings) {
        // Load existing settings
        loadSettings(settings);

        // Set up change listeners for all settings
        for (const key of Object.keys(GARB_DEFAULTS)) {
            if (settings.manifest[key] && settings.manifest[key].addEvent) {
                settings.manifest[key].addEvent("action", function () {
                    const value = settings.manifest[key].get();
                    saveSetting(key, value);
                });
            }
        }

        // Reset button handler
        if (settings.manifest.resetButton) {
            settings.manifest.resetButton.addEvent("action", function () {
                if (confirm("Reset all settings to defaults?")) {
                    resetToDefaults(settings);
                }
            });
        }
    });
});
