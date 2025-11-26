// https://stackoverflow.com/questions/55637406/how-to-remove-this-cross-origin-read-blocking-corb-blocked-cross-origin-respo
// https://www.chromium.org/Home/chromium-security/extension-content-script-fetches
// https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
// https://developer.chrome.com/extensions/background_pages
// https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch
// https://developer.mozilla.org/en-US/docs/Learn/JavaScript/Client-side_web_APIs/Fetching_data
// https://developer.chrome.com/extensions/runtime#method-sendMessage
// https://scotch.io/tutorials/how-to-use-the-javascript-fetch-api-to-get-data

const API_URL = "https://garb-api-service.onrender.com";
const EXTRACT_URL = "https://garb-extraction-service.onrender.com";

let authenticated = true;
let authUser = 'testUser';
let authCode = 0;
let contentScriptTabId = 0;

chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {

      // NEW: Handle popup actions
      if (request.action === "getAuthState") {
        sendResponse({
          user: authUser,
          authenticated: authenticated,
          authCode: authCode
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

      // Request to scrape the webpage and return the text data
      if (request.contentScriptQuery == "extractURLContent") {
        var url = EXTRACT_URL;
        fetch(url, {
            method: "POST",
            mode: "cors", // no-cors, cors, *same-origin
            credentials: "same-origin", // include, *same-origin, omit
            headers: {
                "Content-Type": "text/plain",
            },
            redirect: "follow", // manual, *follow, error
            referrer: "no-referrer", // no-referrer, *client
            body: request.data, // body data type must match "Content-Type" header
        })
        .then((resp) => resp.json()) // Transform the data into json
        .then(function(data) {
            sendResponse(data);
          })
        .catch(error => console.log(error))
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
        var url = `${API_URL}//pageSessions/${user}/${pageUrl}`;
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
  fetch(url, {
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
  var url = `${API_URL}//signin`;

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
  })
  .catch((error) => {
    console.log(error);
    authCode = 401;
  });
  return authenticated;  // Will respond asynchronously.
}

function signout() {
  authenticated = false;
}


/**************** PRE SET ****************/

// if you checked "fancy-settings" in extensionizr.com, uncomment this lines

// var settings = new Store("settings", {
//     "sample_setting": "This is how you use Store.js to remember values"
// });


//example of using a message handler from the inject scripts
// chrome.extension.onMessage.addListener(
//   function(request, sender, sendResponse) {
//   	chrome.pageAction.show(sender.tab.id);
//     sendResponse();
//   });

// chrome.browserAction.onClicked.addListener(function(activeTab) {
//   chrome.tabs.executeScript(null, {file: "content.js"});
// });s
