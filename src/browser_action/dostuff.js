/**
 * GARB Extension Popup Controller
 * Handles consent, authentication, eye tracking activation, and data export
 */

let currentMode = 1;
let isActivated = false;
let participantId = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    // Check consent state first
    checkConsentState();

    // Consent checkbox enables/disables consent button
    document.getElementById('consentCheckbox').addEventListener('change', function() {
        document.getElementById('giveConsentBtn').disabled = !this.checked;
    });

    // Consent button
    document.getElementById('giveConsentBtn').addEventListener('click', giveConsent);

    // Auth buttons
    document.getElementById('signin').addEventListener('click', signinUser);
    document.getElementById('signup').addEventListener('click', signupUser);
    document.getElementById('signout').addEventListener('click', signoutUser);

    // Activation/Deactivation toggle
    document.getElementById('extActivateButton').addEventListener('click', toggleTracking);

    // Mode selection
    document.getElementById('mode1').addEventListener('click', () => changeMode(1));
    document.getElementById('mode2').addEventListener('click', () => changeMode(2));

    // Footer actions
    document.getElementById('exportDataBtn').addEventListener('click', exportData);
    document.getElementById('revokeConsentBtn').addEventListener('click', revokeConsent);

    // Allow Enter key to submit login form
    document.getElementById('password').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            signinUser();
        }
    });

    // Check if tracking is already active on current tab
    checkTrackingStatus();
});

/**
 * Check if user has given consent
 */
async function checkConsentState() {
    try {
        const response = await chrome.runtime.sendMessage({ action: "getConsentState" });

        if (response && response.hasConsented) {
            // User has consented, show main content
            participantId = response.participantId;
            showMainContent();
            updateRender();
        } else {
            // Show consent screen
            showConsentScreen();
        }
    } catch (error) {
        console.error("Error checking consent:", error);
        showConsentScreen();
    }
}

/**
 * Show the consent screen
 */
function showConsentScreen() {
    document.getElementById('consentScreen').style.display = 'block';
    document.getElementById('mainContent').style.display = 'none';
}

/**
 * Show the main content area
 */
function showMainContent() {
    document.getElementById('consentScreen').style.display = 'none';
    document.getElementById('mainContent').style.display = 'block';

    // Display participant ID
    if (participantId) {
        document.getElementById('participantIdDisplay').textContent = participantId;
    }
}

/**
 * Handle consent agreement
 */
async function giveConsent() {
    try {
        const response = await chrome.runtime.sendMessage({ action: "giveConsent" });

        if (response && response.success) {
            participantId = response.participantId;
            showMainContent();
            updateRender();
        }
    } catch (error) {
        console.error("Error giving consent:", error);
    }
}

/**
 * Revoke consent and clear data
 */
async function revokeConsent() {
    const confirmed = confirm(
        "Are you sure you want to revoke consent?\n\n" +
        "This will:\n" +
        "- Sign you out\n" +
        "- Clear your local data\n" +
        "- Remove your participant ID\n\n" +
        "Your data on the server will remain for research purposes."
    );

    if (confirmed) {
        try {
            await chrome.runtime.sendMessage({ action: "revokeConsent" });
            showConsentScreen();

            // Reset checkbox
            document.getElementById('consentCheckbox').checked = false;
            document.getElementById('giveConsentBtn').disabled = true;
        } catch (error) {
            console.error("Error revoking consent:", error);
        }
    }
}

/**
 * Export participant data as JSON
 */
async function exportData() {
    const btn = document.getElementById('exportDataBtn');
    const originalText = btn.textContent;
    btn.textContent = 'Exporting...';
    btn.disabled = true;

    try {
        const response = await chrome.runtime.sendMessage({ action: "exportData" });

        if (response && response.success) {
            // Create and download JSON file
            const dataStr = JSON.stringify(response.data, null, 2);
            const blob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `garb-data-${participantId || 'export'}-${Date.now()}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showMessage("Data exported successfully!", 'success');
        } else {
            showMessage("Failed to export data: " + (response.error || "Unknown error"), 'error');
        }
    } catch (error) {
        console.error("Export error:", error);
        showMessage("Failed to export data. Please try again.", 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

/**
 * Check if tracking is active on the current tab
 */
async function checkTrackingStatus() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        // Skip browser internal pages
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
            return;
        }

        try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: "getStatus" });
            if (response && response.isActivated) {
                isActivated = true;
                updateActivateButton(true);
                updateStatus('connected', 'Eye tracking active');
            }
        } catch (e) {
            // Content script not loaded, that's fine
        }
    } catch (error) {
        console.log("Could not check tracking status:", error);
    }
}

/**
 * Update the activate/deactivate button state
 */
function updateActivateButton(active) {
    const btn = document.getElementById('extActivateButton');
    if (active) {
        btn.textContent = 'Stop Tracking';
        btn.classList.remove('btn-success');
        btn.classList.add('btn-danger');
        btn.disabled = false;
    } else {
        btn.textContent = 'Activate Eye Tracking';
        btn.classList.remove('btn-danger', 'btn-secondary');
        btn.classList.add('btn-success');
        btn.disabled = false;
    }
}

/**
 * Toggle eye tracking on/off
 */
async function toggleTracking() {
    if (isActivated) {
        await deactivateExtension();
    } else {
        await activateExtension();
    }
}

/**
 * Deactivate eye tracking on the current page
 */
async function deactivateExtension() {
    console.log("Deactivating eye tracking...");
    updateStatus('pending', 'Stopping...');

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            throw new Error("No active tab found");
        }

        const response = await chrome.tabs.sendMessage(tab.id, { action: "deactivate" });

        if (response && response.success) {
            isActivated = false;
            updateActivateButton(false);
            updateStatus('disconnected', 'Tracking stopped');
            showMessage("Eye tracking stopped. Page will reload.", 'success');
        }
    } catch (error) {
        console.error("Failed to deactivate:", error);
        isActivated = false;
        updateActivateButton(false);
        updateStatus('disconnected', 'Ready');
    }
}

/**
 * Activate eye tracking on the current page
 */
async function activateExtension() {
    console.log("Activating eye tracking...");
    updateStatus('pending', 'Activating...');

    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab) {
            throw new Error("No active tab found");
        }

        // Check if this is a valid page for eye tracking
        if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
            throw new Error("Cannot activate on browser internal pages");
        }

        // Try to send message to content script
        let response;
        try {
            response = await chrome.tabs.sendMessage(tab.id, { action: "activate" });
        } catch (sendError) {
            // Content script might not be injected yet, try injecting it
            console.log("Content script not responding, attempting to inject...");

            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['js/jquery/jquery.min.js', 'src/inject/inject.js']
                });

                // Wait a moment for script to initialize
                await new Promise(resolve => setTimeout(resolve, 100));

                // Try again
                response = await chrome.tabs.sendMessage(tab.id, { action: "activate" });
            } catch (injectError) {
                console.error("Failed to inject content script:", injectError);
                throw new Error("Could not inject content script. Try refreshing the page.");
            }
        }

        console.log("Activation response:", response);

        if (response && response.success) {
            isActivated = true;
            updateActivateButton(true);
            updateStatus('connected', 'Eye tracking active');
        } else {
            throw new Error("Activation failed");
        }
    } catch (error) {
        console.error("Failed to activate:", error);
        updateStatus('disconnected', 'Activation failed');
        showMessage(error.message || "Failed to activate. Make sure the eye tracker service is running and refresh the page.", 'error');
    }
}

/**
 * Change the visualization mode
 */
function changeMode(mode) {
    currentMode = mode;
    console.log("Changing mode to:", mode);

    // Update UI to show active mode
    document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById('mode' + mode).classList.add('active');

    // Send mode to background/content script
    chrome.runtime.sendMessage({ action: "sendMode", mode: mode });
}

/**
 * Sign up new user
 */
async function signupUser() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    if (!username || !password) {
        showMessage("Please enter both username and password", 'error');
        return;
    }

    if (password.length < 4) {
        showMessage("Password must be at least 4 characters", 'error');
        return;
    }

    showMessage("Creating account...", 'success');

    try {
        await chrome.runtime.sendMessage({
            action: "signup",
            username: username,
            password: password
        });

        await updateRender();
    } catch (error) {
        console.error("Signup error:", error);
        showMessage("Failed to create account. Please try again.", 'error');
    }
}

/**
 * Sign in existing user
 */
async function signinUser() {
    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;

    if (!username || !password) {
        showMessage("Please enter both username and password", 'error');
        return;
    }

    showMessage("Signing in...", 'success');

    try {
        const response = await chrome.runtime.sendMessage({
            action: "signin",
            username: username,
            password: password
        });

        console.log("Sign in response:", response);
        await updateRender();
    } catch (error) {
        console.error("Signin error:", error);
        showMessage("Failed to sign in. Please try again.", 'error');
    }
}

/**
 * Sign out current user
 */
function signoutUser() {
    chrome.runtime.sendMessage({ action: "signout" });
    isActivated = false;
    updateStatus('disconnected', 'Not activated');
    updateRender();
}

/**
 * Update the popup UI based on authentication state
 */
async function updateRender() {
    console.log("Updating popup render...");

    try {
        const response = await chrome.runtime.sendMessage({ action: "getAuthState" });

        if (!response) {
            console.log("No response from background");
            return;
        }

        const { user, authenticated, authCode, participantId: pid } = response;
        console.log("Auth state:", { user, authenticated, authCode, pid });

        // Update participant ID display
        if (pid) {
            participantId = pid;
            document.getElementById('participantIdDisplay').textContent = pid;
        }

        // Handle error codes
        if (authCode === 401 || authCode === 404 || authCode === 400) {
            showMessage("Invalid username or password. Please try again.", 'error');
        } else if (authCode === 422) {
            showMessage("That username already exists. Try signing in instead.", 'error');
        } else if (authCode === 200 || authCode === 0) {
            clearMessage();
        } else if (authCode >= 500) {
            showMessage("Server error. Please try again later.", 'error');
        }

        // Update view based on authentication
        if (authenticated) {
            document.getElementById("login").style.display = "none";
            document.getElementById("login2").style.display = "block";
            document.getElementById("displayUsername").textContent = user || "User";

            if (!isActivated) {
                updateStatus('disconnected', 'Ready - click Activate');
            }
        } else {
            document.getElementById("login").style.display = "block";
            document.getElementById("login2").style.display = "none";
            updateStatus('disconnected', 'Please sign in');
        }
    } catch (error) {
        console.error("Error updating render:", error);
    }
}

/**
 * Update the status bar
 */
function updateStatus(state, text) {
    const statusBar = document.getElementById('statusBar');
    const statusText = document.getElementById('statusText');

    statusBar.className = 'status-bar ' + state;
    statusText.textContent = text;
}

/**
 * Show a message in the sign-in message area
 */
function showMessage(text, type) {
    const messageEl = document.getElementById('signInMessage');
    messageEl.textContent = text;
    messageEl.className = type || '';
}

/**
 * Clear the message area
 */
function clearMessage() {
    const messageEl = document.getElementById('signInMessage');
    messageEl.textContent = '';
    messageEl.className = '';
}
