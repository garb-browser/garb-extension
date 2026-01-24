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
        // alert("inside savetodatabase")  // REMOVE - alert doesn't work in MV3
        var url = `${API_URL}/pageSessions`;
        console.log("saving to DB");  // Use console.log instead of alert
        //const testData = {
        //    url: 'testURL',
        //    title: 'title',
        //    user: 1,
        //    timestampStart: 0,
        //    timestampEnd: 10,
        //    sessionClosed: true,
        //    quadFreqs: [[10, 10, 10, 10], [11, 11, 11, 11]]
        //  };

        fetch(url, {
            method: "POST",
            mode: "cors", // no-cors, cors, *same-origin
            credentials: "same-origin", // include, *same-origin, omit
            headers: {
                "Content-Type": "application/json",
            },
            redirect: "follow", // manual, *follow, error
            referrer: "no-referrer", // no-referrer, *client
            body: JSON.stringify(request.data), // body data type must match "Content-Type" header
        })
        .then((resp) => resp.json()) // Transform the data into json
        .then(function(data) {
            sendResponse(data);
          })
        .catch(error => console.log(error))
        return true;  // Will respond asynchronously.
        
      
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

    const url = `${API_URL}/pageSessions/${user}`;

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

        // Format data for export
        const exportData = {
            participantId: participantId,
            username: user,
            exportDate: new Date().toISOString(),
            totalSessions: sessions.length,
            sessions: sessions.map(session => ({
                url: session.url,
                title: session.title,
                timestampStart: session.timestampStart,
                timestampEnd: session.timestampEnd,
                durationMs: session.timestampEnd - session.timestampStart,
                sessionClosed: session.sessionClosed,
                quadFreqs: session.quadFreqs
            }))
        };

        return exportData;
    } catch (error) {
        console.error("Export error:", error);
        throw error;
    }
}
