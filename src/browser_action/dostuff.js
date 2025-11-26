/*
// set current url to something else
chrome.tabs.query({currentWindow: true, active: true}, function (tab) {
    chrome.tabs.update(tab.id, {url: "http://www.espn.com/"});
});
*/

var authResult;

// Function to activate the extension
async function activateExtension() {
    console.log("RUNNING - Sending activation message to content script");
    
    // Get the current active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // Send activation message to the loader content script
    try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: "activate" });
        console.log("Activation response:", response);
    } catch (error) {
        console.error("Failed to activate:", error);
        alert("Failed to activate. Please refresh the page and try again.");
    }
}

document.getElementById('extActivateButton').onclick = activateExtension;
document.getElementById('signup').onclick = signupUser;
document.getElementById('signin').onclick = signinUser;
document.getElementById('signout').onclick = signoutUser;
document.getElementById('mode1').onclick = () => changeMode(1);
document.getElementById('mode2').onclick = () => changeMode(2);
document.getElementById('mode3').onclick = () => changeMode(3);
document.getElementById('mode4').onclick = () => changeMode(4);
document.getElementById('mode5').onclick = () => changeMode(5);
document.getElementById('mode6').onclick = () => changeMode(6);
document.getElementById('mode7').onclick = () => changeMode(7);
document.getElementById('mode8').onclick = () => changeMode(8);
document.getElementById('mode9').onclick = () => changeMode(9);
document.getElementById('mode10').onclick = () => changeMode(10);

function changeMode(i) {
    console.log("Changing mode to:", i);
    chrome.runtime.sendMessage({ action: "sendMode", mode: i });
}

// Function to sign up
async function signupUser() {
    var username = document.getElementById("username").value;
    var password = document.getElementById("password").value;
    
    const response = await chrome.runtime.sendMessage({ 
        action: "signup", 
        username: username, 
        password: password 
    });
    
    updateRender();
}

// Function to sign in
async function signinUser() {
    var username = document.getElementById("username").value;
    var password = document.getElementById("password").value;
    
    const response = await chrome.runtime.sendMessage({ 
        action: "signin", 
        username: username, 
        password: password 
    });
    
    console.log("Sign in response:", response);
    updateRender();
}

// Function to sign out
function signoutUser() {
    chrome.runtime.sendMessage({ action: "signout" });
    updateRender();
}

// Function to update the popup rendering
async function updateRender() {
    console.log("updating!");
    
    const response = await chrome.runtime.sendMessage({ action: "getAuthState" });
    
    if (!response) {
        console.log("No response from background");
        return;
    }
    
    let username = response.user;
    let authenticated = response.authenticated;
    let authCode = response.authCode;
    console.log("User:", username, "Auth:", authenticated, "Code:", authCode);
    
    // Error code for unauthorized / resource not found
    if (authCode == 401 || authCode == 404 || authCode == 400) {
        setColor("signInMessage", "red");
        setText("signInMessage", "Your login credentials are incorrect. Please try again.");
    } 
    // Successful login
    else if (authCode == 200 || authCode == 0) {
        setText("signInMessage", "");
    }
    // Unsuccessful sign up
    else if (authCode == 422) {
        setColor("signInMessage", "red");
        setText("signInMessage", "That username already exists.");
    } else {
        setColor("signInMessage", "red");
        setText("signInMessage", "Something has gone wrong. Please try again.");
    }

    // Changing styling based on authentication
    if (authenticated) {
        document.getElementById("signInMessage").innerHTML = `You are signed in as ${username}!`; 
        setColor("signInMessage", "black");
        document.getElementById("mainPopup").style.backgroundColor = 'green';
        document.getElementById("login").style.display = "none";
        document.getElementById("login2").style.display = "block";
    }
    else {
        document.getElementById("mainPopup").style.backgroundColor = 'white'; 
        document.getElementById("login").style.display = "block";
        document.getElementById("login2").style.display = "none";
    }
}

updateRender();

// HELPER FUNCTIONS
function setColor(id, color) {
    document.getElementById(id).style.color = color;
}

function setText(id, text) {
    document.getElementById(id).innerHTML = text;
}