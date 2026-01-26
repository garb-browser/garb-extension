/**
 * GARB Extension - Background Service Worker
 * Handles authentication, API calls, and participant management
 */

const API_URL = "https://garb-api-service.onrender.com";
// const EXTRACT_URL = "https://garb-extraction-service.onrender.com";
const EXTRACT_URL = "http://localhost:9000";

// Authentication state
let authenticated = false;
let authUser = '';
let authCode = 0;
let contentScriptTabId = 0;

// Participant management
let participantId = null;
let hasConsented = false;

// Initialize on startup
chrome.runtime.onInstalled.addListener(() => {
    console.log("GARB Extension installed/updated");
    loadStoredState();
});

// Load stored state on service worker start
loadStoredState();

async function loadStoredState() {
    try {
        const data = await chrome.storage.local.get(['participantId', 'hasConsented', 'authUser']);
        if (data.participantId) {
            participantId = data.participantId;
        }
        if (data.hasConsented) {
            hasConsented = data.hasConsented;
        }
        if (data.authUser) {
            authUser = data.authUser;
            authenticated = true;
        }
        console.log("Loaded state:", { participantId, hasConsented, authUser: !!authUser });
    } catch (error) {
        console.error("Error loading stored state:", error);
    }
}

// Generate a unique participant ID
function generateParticipantId() {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substring(2, 8);
    return `P-${timestamp}-${randomPart}`.toUpperCase();
}

chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {

      // === CONSENT & PARTICIPANT MANAGEMENT ===

      if (request.action === "getConsentState") {
        // Read directly from storage to avoid race conditions with service worker startup
        chrome.storage.local.get(['participantId', 'hasConsented']).then(data => {
          // Also update global state
          if (data.hasConsented) hasConsented = data.hasConsented;
          if (data.participantId) participantId = data.participantId;

          sendResponse({
            hasConsented: data.hasConsented || false,
            participantId: data.participantId || null
          });
        }).catch(error => {
          console.error("Error reading consent state:", error);
          sendResponse({
            hasConsented: hasConsented,
            participantId: participantId
          });
        });
        return true;
      }

      else if (request.action === "giveConsent") {
        hasConsented = true;
        participantId = generateParticipantId();
        chrome.storage.local.set({
            hasConsented: true,
            participantId: participantId
        });
        sendResponse({
            success: true,
            participantId: participantId
        });
        return true;
      }

      else if (request.action === "revokeConsent") {
        hasConsented = false;
        participantId = null;
        authenticated = false;
        authUser = '';
        chrome.storage.local.clear();
        sendResponse({ success: true });
        return true;
      }

      // === AUTHENTICATION ===

      else if (request.action === "getAuthState") {
        // Read directly from storage to avoid race conditions with service worker startup
        chrome.storage.local.get(['participantId', 'hasConsented', 'authUser']).then(data => {
          // Also update global state
          if (data.hasConsented) hasConsented = data.hasConsented;
          if (data.participantId) participantId = data.participantId;
          if (data.authUser) {
            authUser = data.authUser;
            authenticated = true;
          }

          sendResponse({
            user: data.authUser || authUser,
            authenticated: !!data.authUser || authenticated,
            authCode: authCode,
            participantId: data.participantId || participantId,
            hasConsented: data.hasConsented || hasConsented
          });
        }).catch(error => {
          console.error("Error reading auth state:", error);
          sendResponse({
            user: authUser,
            authenticated: authenticated,
            authCode: authCode,
            participantId: participantId,
            hasConsented: hasConsented
          });
        });
        return true;
      }

      else if (request.action === "signin") {
        signin(request.username, request.password).then(() => {
          sendResponse({ success: true, authCode: authCode });
        });
        return true;
      }

      else if (request.action === "signup") {
        signup(request.username, request.password).then(() => {
          sendResponse({ success: true, authCode: authCode });
        });
        return true;
      }

      else if (request.action === "signout") {
        signout();
        sendResponse({ success: true });
        return true;
      }

      else if (request.action === "sendMode") {
        sendMode(request.mode);
        sendResponse({ success: true });
        return true;
      }

      // === DATA EXPORT ===

      else if (request.action === "exportData") {
        exportParticipantData(request.user).then(data => {
            sendResponse({ success: true, data: data });
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
      }

      // Request to scrape the webpage and return the text data
      // Always uses raw HTML from the extension for reliability (avoids rate limiting)
      if (request.contentScriptQuery == "extractURLContent") {
        const extractUrl = EXTRACT_URL;
        const requestData = request.data;

        // Support both old format (string) and new format (object with url and html)
        const targetUrl = typeof requestData === 'string' ? requestData : requestData.url;
        const pageHtml = typeof requestData === 'object' ? requestData.html : null;

        console.log("Extracting:", targetUrl);

        // Always send raw HTML directly - faster and avoids rate limiting
        fetch(extractUrl, {
            method: "POST",
            mode: "cors",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
            },
            redirect: "follow",
            referrer: "no-referrer",
            body: JSON.stringify({ url: targetUrl, html: pageHtml }),
        })
        .then((resp) => {
            console.log("Extraction response status:", resp.status);
            return resp.json();
        })
        .then(function(data) {
            console.log("Extraction result:", data.title || data.error || "unknown");
            sendResponse(data);
        })
        .catch(error => {
            console.error("Extraction error:", error);
            sendResponse({ error: error.message, content: '', formatted_content: [] });
        });
        return true;  // Will respond asynchronously.
      }

      // Request to save the current pagesession data to the database
      else if (request.contentScriptQuery == "saveToDatabase") {
        // Validate request data
        if (!request.data) {
            console.error("GARB: No data provided for saveToDatabase");
            sendResponse({ error: "No data provided" });
            return true;
        }

        const url = `${API_URL}/pageSessions`;
        console.log("GARB: Saving session to DB for user:", request.data?.user);

        // Safely stringify and check payload size
        let jsonPayload;
        try {
            jsonPayload = JSON.stringify(request.data);
            const payloadSizeKB = Math.round(jsonPayload.length / 1024);
            console.log(`GARB: Payload size: ${payloadSizeKB}KB`);

            // Log size breakdown for debugging
            const sizeBreakdown = {};
            for (const key of Object.keys(request.data)) {
                const fieldSize = JSON.stringify(request.data[key]).length;
                if (fieldSize > 1000) {
                    sizeBreakdown[key] = Math.round(fieldSize / 1024) + 'KB';
                }
            }
            if (Object.keys(sizeBreakdown).length > 0) {
                console.log("GARB: Large fields:", sizeBreakdown);
            }

            // Warn if payload is very large
            if (payloadSizeKB > 800) {
                console.warn(`GARB: Payload is large (${payloadSizeKB}KB) - may cause 413 errors`);
            }

            console.log("GARB: Session data preview:", jsonPayload.substring(0, 500));
        } catch (e) {
            console.log("GARB: Could not stringify data for logging");
            jsonPayload = JSON.stringify(request.data);
        }

        fetch(url, {
            method: "POST",
            mode: "cors",
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
            },
            redirect: "follow",
            referrer: "no-referrer",
            body: jsonPayload, // Use pre-stringified payload
        })
        .then((resp) => {
            console.log("GARB: Save response status:", resp.status);
            if (!resp.ok) {
                // Try to get error details from response body
                return resp.text().then(text => {
                    throw new Error(`Save failed (${resp.status}): ${text.substring(0, 200)}`);
                });
            }
            return resp.json();
        })
        .then(function(data) {
            console.log("GARB: Session saved successfully:", data);
            sendResponse(data);
        })
        .catch(error => {
            console.error("GARB: Save error:", error);
            sendResponse({ error: error.message || "Unknown save error" });
        });
        return true;
      }

      // Save survey responses to the most recent session
      else if (request.contentScriptQuery == "saveSurveyResponses") {
        console.log("Saving survey responses", request.data);

        // Get user from request data or fall back to authUser
        const user = request.data.user || authUser;
        if (!user) {
            console.error("No user found for saving survey");
            sendResponse({ success: false, error: "No user logged in" });
            return true;
        }

        // First get the most recent session for this user/url to update it
        const encodedUrl = encodeURIComponent(request.data.url);
        const getUrl = `${API_URL}/pageSessions/${user}/${encodedUrl}`;
        console.log("Fetching sessions from:", getUrl);

        fetch(getUrl)
            .then(resp => {
                if (!resp.ok) {
                    throw new Error(`Failed to fetch sessions: ${resp.status}`);
                }
                return resp.json();
            })
            .then(sessions => {
                console.log("Found sessions:", sessions);

                // Defensive check: ensure sessions is an array
                if (!Array.isArray(sessions)) {
                    console.error("Expected array of sessions, got:", typeof sessions);
                    throw new Error("Invalid response from server - expected array of sessions");
                }

                if (sessions.length > 0) {
                    // Get the most recent session (create a copy to avoid mutating original)
                    const sortedSessions = [...sessions].sort((a, b) =>
                        new Date(b.timestampStart || 0) - new Date(a.timestampStart || 0)
                    );
                    const mostRecent = sortedSessions[0];

                    console.log("Updating session:", mostRecent._id);

                    // Update it with survey responses
                    const updateUrl = `${API_URL}/pageSessions/${mostRecent._id}`;
                    return fetch(updateUrl, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            survey_responses: request.data.survey_responses
                        })
                    });
                } else {
                    throw new Error("No session found to update");
                }
            })
            .then(resp => {
                if (!resp.ok) {
                    throw new Error(`Failed to update session: ${resp.status}`);
                }
                return resp.json();
            })
            .then(data => {
                console.log("Survey responses saved:", data);
                sendResponse({ success: true, data: data });
            })
            .catch(error => {
                console.error("Error saving survey:", error);
                sendResponse({ success: false, error: error.message });
            });

        return true;
      }
      
      // Request to get a pagesession object from the database
      else if (request.contentScriptQuery == "getFromDatabase") {

        // Get the user and url
        var user = request.data.user;
        var pageUrl = encodeURIComponent(request.data.url);
        var url = `${API_URL}/pageSessions/${user}/${pageUrl}`;
        console.log(url);  // Use console.log instead of alert

        fetch(url, {
            method: "GET",
            mode: "cors", // no-cors, cors, *same-origin
            credentials: "same-origin", // include, *same-origin, omit
            headers: {
                "Content-Type": "application/json",
                // "Content-Type": "application/x-www-form-urlencoded",
            },
            redirect: "follow", // manual, *follow, error
            referrer: "no-referrer", // no-referrer, *client
            // body: JSON.stringify(request.data), // body data type must match "Content-Type" header
        })
        .then((resp) => resp.json()) // Transform the data into json
        .then(function(data) {
          sendResponse(data);
        })
        .catch(error => {
          console.log(error);
          sendResponse(null);
        });
        return true;  // Will respond asynchronously.
      }

      // Request to get the current user object
      else if (request.contentScriptQuery == "getUser") {
        sendResponse(authUser);
        return true;
      }

      // Request to get the content script's tab ID
      else if (request.contentScriptQuery == "sendTabId") {
        console.log("Sender's tab id is: ", sender.tab.id);
        contentScriptTabId = sender.tab.id;
        sendResponse("From background.js: Got your tabId!");
        return true;
      }
      else if (request.contentScriptQuery == "showDistractionMetric") {
        let myData = request.data;
        console.log(myData);
        let focusedTimeInSecs = myData.focusedTimeInSeconds;
        let distractionPercent =  (1 - (focusedTimeInSecs / myData.totalTime)).toFixed(4) * 100;
        let myString = `Total time spent: ${myData.totalTime} seconds\n
                        Time spent distracted: ${distractionPercent}%\n`
        console.log(myString);  // Use console.log instead of alert
        // Send message to content script to show notification if needed
      }
    }
);

function sendMode(i) {
  console.log("trying to send to inject.js, mode:", i);
  
  // Send to the stored tab ID if available
  if (contentScriptTabId) {
    chrome.tabs.sendMessage(contentScriptTabId, {switchMode: i}).catch(err => {
      console.log("Error sending to stored tab:", err);
    });
  }
  
  // Also try sending to the active tab as fallback
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    if (tabs[0] && tabs[0].id !== contentScriptTabId) {
      chrome.tabs.sendMessage(tabs[0].id, {switchMode: i}).catch(err => {
        console.log("Error sending to active tab:", err);
      });
    }
  });
  
  console.log("after chrome.tabs.sendMessage");
  // chrome.runtime.sendMessage(
  //   {contentScriptQuery: "getMode", data: i},
  //   result => {
  //     console.log("successfully sent message to inject.js");
  //     chrome.tabs.getSelected(null, function(tabs) {
  //       console.log(tabs.id);
  //     console.log(chrome.tabs);
  //     console.log(chrome.extension);
  //   }); 
  //   }


  // var event = new CustomEvent("getMode", {
  //   body: {
  //     mode: i
  //   }
  // });

  // window.dispatchEvent(event);
}

// AUTHENTICATION

// Getter method for authentication
function getAuth() {
  return authenticated;
}

function getAuthCode() {
  return authCode;
}

function getUser() {
  return authUser;
}


// Function to sign up ---------------------------
async function signup(username, password) {
  const fields = {username, password};
  var url = `${API_URL}/signup`;

  // Fetch request
  await fetch(url, {
      method: "POST",
      mode: "cors", // no-cors, cors, *same-origin
      credentials: "same-origin", // include, *same-origin, omit
      headers: {
          "Content-Type": "application/json",
          // "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "follow", // manual, *follow, error
      referrer: "no-referrer", // no-referrer, *client
      body: JSON.stringify(fields), // body data type must match "Content-Type" header
  })
  .then((resp) => {
    authenticated = resp.ok;
    authCode = resp.status;
    authUser = username;
    // Persist auth state to storage on successful signup
    if (resp.ok) {
      chrome.storage.local.set({ authUser: username });
    }
  })
  .catch(error => {
    console.log(error);
    authCode = 401;
  });
  return authenticated;  // Will respond asynchronously.
}


// Function to sign in ------------------------------
async function signin(username, password) {
  const fields = {username, password};
  var url = `${API_URL}/signin`;

  // Fetch request
  await fetch(url, {
      method: "POST",
      mode: "cors", // no-cors, cors, *same-origin
      credentials: "same-origin", // include, *same-origin, omit
      headers: {
          "Content-Type": "application/json",
          // "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "follow", // manual, *follow, error
      referrer: "no-referrer", // no-referrer, *client
      body: JSON.stringify(fields), // body data type must match "Content-Type" header
  })
  .then((resp) => {
    authenticated = resp.ok;
    authCode = resp.status;
    authUser = username;
    // Persist auth state to storage on successful signin
    if (resp.ok) {
      chrome.storage.local.set({ authUser: username });
    }
  })
  .catch((error) => {
    console.log(error);
    authCode = 401;
  });
  return authenticated;  // Will respond asynchronously.
}

function signout() {
  authenticated = false;
  authUser = '';
  chrome.storage.local.remove(['authUser']);
}


// === DATA EXPORT ===

async function exportParticipantData(username) {
    const user = username || authUser;
    if (!user) {
        throw new Error("No user specified for export");
    }

    // Use the correct API endpoint for getting all user sessions
    const url = `${API_URL}/pageSessions/user/${user}`;

    try {
        const response = await fetch(url, {
            method: "GET",
            mode: "cors",
            headers: {
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch data: ${response.status}`);
        }

        const sessions = await response.json();

        // Format data for export - include all research data
        const exportData = {
            participantId: participantId,
            username: user,
            exportDate: new Date().toISOString(),
            totalSessions: sessions.length,

            // === METHOD DOCUMENTATION (for research paper reporting) ===
            methods: {
                eye_tracker: {
                    model: "Tobii Eye Tracker 5",
                    type: "Consumer-grade screen-based",
                    sampling_rate_hz: 60,
                    calibration: "Native Tobii 9-point calibration",
                    data_access: "WebSocket connection to local Tobii service"
                },
                gaze_processing: {
                    smoothing: "Exponential Moving Average (alpha=0.3, adaptive based on velocity)",
                    fixation_detection: "I-VT algorithm (velocity threshold 30px/sample, minimum duration 100ms)",
                    saccade_detection: "Velocity threshold (800px/sec with 50ms freeze period)"
                },
                line_tracking: {
                    aoi_definition: "Line bounding rectangles from DOM .garb-line elements",
                    line_lock: "Hysteresis-based (time=250ms dwell, margin=40px instant switch)",
                    word_tracking: "Progressive fill indicator (advances with gaze, never regresses)"
                },
                data_quality: {
                    confidence_calculation: "Velocity + spatial consistency based (0-1 scale)",
                    tracking_lost_threshold: "2000ms without valid gaze on text",
                    blink_detection: "Data gaps 100-500ms classified as blinks",
                    precision_measure: "RMS of gaze variance during fixations (pixels)"
                },
                limitations: [
                    "Accuracy: No ground truth targets - confidence is a proxy only",
                    "Pupil diameter: Not available from consumer Tobii SDK",
                    "Viewing distance: Not measured (no depth camera)",
                    "Lighting conditions: Not measurable from browser",
                    "Head movement: Limited compensation from consumer tracker"
                ]
            },

            sessions: sessions.map(session => ({
                // Core session info
                sessionId: session._id,
                url: session.url,
                title: session.title,
                timestampStart: session.timestampStart,
                timestampEnd: session.timestampEnd,
                durationMs: session.timestampEnd && session.timestampStart
                    ? new Date(session.timestampEnd) - new Date(session.timestampStart)
                    : null,
                sessionClosed: session.sessionClosed,

                // Research data
                summary: session.summary || null,
                settings_snapshot: session.settings_snapshot || null,
                survey_responses: session.survey_responses || null,

                // Device and environment metadata
                device_metadata: session.device_metadata || null,
                processing_methods: session.processing_methods || null,

                // Event streams (JSONL strings)
                gaze_events_jsonl: session.gaze_events_jsonl || '',
                ui_events_jsonl: session.ui_events_jsonl || '',

                // Legacy data
                quadFreqs: session.quadFreqs
            }))
        };

        return exportData;
    } catch (error) {
        console.error("Export error:", error);
        throw error;
    }
}
