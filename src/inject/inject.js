/* 
 * Eye Tracking Extension - Content Script
 * Waits for activation message from popup, then runs eye tracking logic
 */

(function() {
    // Flag to prevent multiple activations
    let isActivated = false;

    // Color schemes for different modes
    const MODE_COLORS = {
        1: ['#ffffff', '#12a9e3'],  // White to Blue
        2: ['#F74040', '#BEBEBE', '#888585', '#BEBEBE'],  // Red/Gray scheme
        3: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff'],  // White/Blue/Orange/Pink
        4: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff'],
        5: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff'],
        6: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff'],
        7: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff'],
        8: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff'],
        9: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff'],
        10: ['#ffffff', '#99cfff', '#ffcc66', '#ffccff']
    };

    // Listen for activation message from popup/background
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        if (request.action === "activate" && !isActivated) {
            console.log("Eye Tracking Extension: Activating...");
            isActivated = true;
            
            // Run the main injection logic
            runInjection();
            
            sendResponse({ success: true });
        }
        
        // Handle mode switching (forwarded from background)
        if (request.switchMode && isActivated) {
            console.log("received message! finally!");
            console.log("The response is: " + request.switchMode);
            if (window.eyeTrackingViewMode !== request.switchMode) {
                window.eyeTrackingViewMode = request.switchMode;
                console.log("viewMode now is: " + window.eyeTrackingViewMode);
                window.eyeTrackingInitialHighlightingDone = false;
            }
        }
        
        return true;
    });

    function runInjection() {
        // Initialize global variables
        window.lineQueue = new Array();
        window.QUEUE_LENGTH = 10;
        window.MIN_PERCENT_READ = 15;
        window.startTime = 0;
        window.focusedTimeInSeconds = 0;
        window.targetSiteURL = location.href;
        window.eyeTrackingViewMode = 1;
        window.eyeTrackingInitialHighlightingDone = false;

        console.log("right before adding listeners");

        // Sending an empty message to background.js so that background.js has the tab id
        chrome.runtime.sendMessage(
            {contentScriptQuery: "sendTabId", data: null},
            result => {
                console.log("Making sure background.js has my tab Id!");
                console.log(result);
            });

        // Start the extraction process
        chrome.runtime.sendMessage(
            {contentScriptQuery: "extractURLContent", data: window.targetSiteURL},
            result => {
                if (!result || !result.content) {
                    console.error("Failed to extract content from page");
                    alert("Failed to extract page content. The extraction service may be unavailable.");
                    return;
                }
                
                processExtractedContent(result);
            });
    }

    function processExtractedContent(result) {
        const titleHTML = `<h1 class="title">${result.title}</h1>`;
        const subHeadHTML = ``;

        var contentHTML = "";
        var rawContentStr = result.content;
        var spanNum = 0;
        var currLineSpans = [];
        var numCharsInQuad = 0;
        var QUAD_SIZE = 23;
        var quadContent = "";
        var quadNum = 0;
        var MAX_QUAD_NUM = 4;
        var currentWord = "";

        for (var i = 0; i < rawContentStr.length; i++) {
            var ch = rawContentStr.charAt(i);

            if ((ch == "\n") && (quadContent != "")) {
                var quadSpan = `<span class="quad" id="${quadNum}${spanNum}">${quadContent}</span>`;
                currLineSpans.push(quadSpan);
                contentHTML += `<span class="line" id="${spanNum}">${currLineSpans.join('')}</span>`;
                contentHTML += "<br>";
                if (currentWord != "") {
                    quadNum = 0;
                    spanNum++;
                    currLineSpans = [];
                    quadSpan = `<span class="quad" id="${quadNum}${spanNum}">${currentWord}</span>`;
                    currLineSpans.push(quadSpan);
                    contentHTML += `<span class="line" id="${spanNum}">${currLineSpans.join('')}</span>`;
                    currentWord = "";
                } 
                contentHTML += "<br><br>";
                numCharsInQuad = 0;
                quadNum = 0;
                spanNum++;
                quadContent = "";
                currLineSpans = [];
            } 
            else if (ch != "\n") {
                if (quadNum == MAX_QUAD_NUM - 1) {
                    if (ch != " ") {
                        currentWord += ch;
                    }
                    else if (currentWord.length + numCharsInQuad + 1 < QUAD_SIZE) {
                        quadContent = quadContent.concat(currentWord);
                        quadContent += ch;
                        numCharsInQuad += currentWord.length + 1;
                        currentWord = "";
                    }
                    else {
                        var quadSpan = `<span class="quad" id="${quadNum}${spanNum}">${quadContent}</span>`;
                        currLineSpans.push(quadSpan);
                        quadContent = currentWord + " ";
                        numCharsInQuad = currentWord.length + 1;
                        quadNum++;
                        currentWord = "";
                    }
                }
                else {
                    quadContent += ch;
                    numCharsInQuad++;
                    if (numCharsInQuad >= QUAD_SIZE) {
                        var quadSpan = `<span class="quad" id="${quadNum}${spanNum}">${quadContent}</span>`;
                        currLineSpans.push(quadSpan);
                        quadContent = "";
                        numCharsInQuad = 0;
                        quadNum++;
                    }
                }

                if (quadNum == MAX_QUAD_NUM) {
                    contentHTML += `<span class="line" id="${spanNum}">${currLineSpans.join('')}</span>`;
                    contentHTML += "<br>";
                    spanNum++;
                    quadNum = 0;
                    currLineSpans = []
                }
            }
        }
        
        if (quadContent != "") {
            contentHTML += `<span class="line" id="${spanNum}">${currLineSpans.join('')}</span>`;
        }
        contentHTML = `<div class="content">${contentHTML}</div>`

        var imgHTML = `<img src="${result.img_src}" alt="N/A">`;
        const articleHTML = `<div class="article">${titleHTML}${imgHTML}${subHeadHTML}${contentHTML}</div>`;

        const newPage = `<head>
                            <title>Eye Tracking Research</title>
                            <link rel="stylesheet" type="text/css">
                        </head>
                        <body>
                            ${articleHTML}
                        </body>`

        document.documentElement.innerHTML = newPage;

        // Load the CSS
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = chrome.runtime.getURL('src/inject/inject.css');
        document.head.appendChild(link);

        // Get user and start tracking
        chrome.runtime.sendMessage(
            {contentScriptQuery: "getUser", data: null},
            result => {
                console.log(result);
                var userData = {
                    user: result,
                    url: window.targetSiteURL
                };
        
                console.log("before getData");
                getData(userData, spanNum);   
            }); 
    }

    function getData(userData, spanNum) {
        var preloadData;

        chrome.runtime.sendMessage(
            {contentScriptQuery: "getFromDatabase", data: userData},
            result => {
                console.log("sent ajax getFromDatabase call");
                console.log(result);
                preloadData = result;

                var quadFreqs = [];
                var tempQuadFreqs = [];
                var dbQuadFreqs = [];
                
                for(var i = 0; i <= spanNum; i++) {
                    quadFreqs.push([0, 0, 0, 0]);
                    dbQuadFreqs.push([0, 0, 0, 0]);
                    tempQuadFreqs[i] = [];
                }

                if (preloadData != null && Array.isArray(preloadData)) {
                    console.log("inside preloadData");
                    console.log(preloadData);
                    preloadData.forEach(function (item, index) {
                        if (item && item.quadFreqs) {
                            for (var i = 0; i < item.quadFreqs.length; i++) {
                                if (tempQuadFreqs[i]) {
                                    tempQuadFreqs[i].push(item.quadFreqs[i]);
                                }
                            } 
                        }
                    });

                    tempQuadFreqs.forEach(function (quadFreqsList, index) {
                        if (dbQuadFreqs[index]) {
                            dbQuadFreqs[index] = getAverageArray(quadFreqsList);
                        }
                    });
                }

                console.log("creating pageSessionData");
                console.log(userData);
                var pageSessionData = {
                    url: window.targetSiteURL,
                    title: document.getElementsByClassName("title")[0].innerHTML,
                    user: userData.user,
                    timestampStart: Date.now(),
                    timestampEnd: null,
                    sessionClosed: false,
                    quadFreqs: null
                };

                runWebSocket(quadFreqs, dbQuadFreqs);

                window.addEventListener("unload", function(event) {
                    const millis = Date.now() - window.startTime;
                    const totalTime = Math.floor(millis / 1000);

                    pageSessionData.timestampEnd = Date.now();
                    pageSessionData.quadFreqs = quadFreqs;
                    pageSessionData.sessionClosed = true;
                    console.log(pageSessionData);
                    chrome.runtime.sendMessage(
                        {contentScriptQuery: "showDistractionMetric", data: {totalTime, focusedTimeInSeconds: window.focusedTimeInSeconds}},
                        result => {
                            console.log("showed distraction metric");
                        });
                    chrome.runtime.sendMessage(
                        {contentScriptQuery: "saveToDatabase", data: pageSessionData},
                        result => {
                            console.log("sent ajax call");
                            console.log(result);
                    });
                });
            });
    }

    function getAverageArray(arrays) {
        if (!arrays || arrays.length === 0) return [0, 0, 0, 0];
        
        var result = [0, 0, 0, 0];
        var count = arrays.length;
        
        for (var i = 0; i < arrays.length; i++) {
            if (arrays[i] && arrays[i].length >= 4) {
                for (var j = 0; j < 4; j++) {
                    result[j] += arrays[i][j];
                }
            }
        }
        
        for (var j = 0; j < 4; j++) {
            result[j] = result[j] / count;
        }
        
        return result;
    }

    function runWebSocket(quadFreqs, dbQuadFreqs) {
        var data = [];
        window.startTime = Date.now();

        if ("WebSocket" in window) {
            var ws = new WebSocket("ws://[::1]:8765/hello");

            ws.onopen = function() {
                ws.send("Socket Opened");
                console.log("WebSocket connected!");
            };

            ws.onerror = function(error) {
                console.log("WebSocket error, trying localhost...", error);
                ws = new WebSocket("ws://127.0.0.1:8765/hello");
                ws.onopen = function() {
                    ws.send("Socket Opened");
                    console.log("WebSocket connected via 127.0.0.1!");
                };
                ws.onmessage = createMessageHandler(ws, quadFreqs, dbQuadFreqs);
                ws.onclose = function() { 
                    alert("Connection is closed..."); 
                };
            };

            ws.onmessage = createMessageHandler(ws, quadFreqs, dbQuadFreqs);

            ws.onclose = function() { 
                alert("Connection is closed..."); 
            };
            
            window.onbeforeunload = function(event) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close();
                }
            }
        }
        else {
            alert("WebSocket NOT supported by your Browser!");
        }
    }

    function createMessageHandler(ws, quadFreqs, dbQuadFreqs) {
        return function(evt) { 
            var received_msg = evt.data;
            var tokens = received_msg.split('|');
            
            if (tokens[0] === 'during') {
                var rawX = parseFloat(tokens[1]);
                var rawY = parseFloat(tokens[2]);

                var scaleX = window.innerWidth / 6000;
                var scaleY = window.innerHeight / 1500;
                var x = rawX * scaleX;
                var y = rawY * scaleY;

                // Call the appropriate highlight mode based on current setting
                var mode = window.eyeTrackingViewMode || 1;
                highlightWithMode(ws, quadFreqs, dbQuadFreqs, x, y, mode);
                
            } else if (tokens[0] == "duration") {
                var temp = tokens[1].split(":");
                var result = temp[2];
                window.focusedTimeInSeconds += parseFloat(result);
            }
        };
    }

    function lineIsValid(lineQueue, newLine) {
        if (lineQueue.length < window.QUEUE_LENGTH) {
            return true;
        }
        
        var sum = 0;
        for (var i = 0; i < lineQueue.length; i++) {
            sum += lineQueue[i];
        }
        var avg = sum / lineQueue.length;
        
        var threshold = 10;
        return Math.abs(newLine - avg) <= threshold;
    }

    // Main highlight function that dispatches to the correct mode
    function highlightWithMode(ws, quadFreqs, dbQuadFreqs, x, y, mode) {
        var colorLvls = MODE_COLORS[mode] || MODE_COLORS[1];
        
        // Mode 1 uses simple 2-color scheme
        if (mode === 1) {
            highlightMode1(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls);
        }
        // Mode 2 uses red/gray scheme with different logic
        else if (mode === 2) {
            highlightMode2(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls);
        }
        // Modes 3-10 use 4-color scheme with similar logic
        else {
            highlightModeMultiColor(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls);
        }
    }

    // Mode 1: Simple blue highlighting
    function highlightMode1(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls) {
        if (!window.eyeTrackingInitialHighlightingDone) {
            for(var i = 0; i < quadFreqs.length; i++) {
                var baseColor = colorLvls[0];
                var spanHandle = document.querySelector(`[id="${i}"].line`);
                if (spanHandle) {
                    spanHandle.style.backgroundColor = baseColor;

                    var freqs = dbQuadFreqs[i];
                    if (freqs && freqs.length >= 4) {
                        var normalisedFreq = freqs[0] + freqs[1] + (10*freqs[2]) + (100 * freqs[3]);
                        var MAX = 450;
                        var percentRead = (normalisedFreq / MAX) * 100;

                        if (percentRead >= window.MIN_PERCENT_READ) {
                            var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[1]}, ${percentRead}%, ${colorLvls[0]})`;
                            spanHandle.style.background = backgroundCSS;
                            dbQuadFreqs[i].push(percentRead);
                        }
                        else {
                            dbQuadFreqs[i].push(0);
                        }
                    }
                }
            }
            window.eyeTrackingInitialHighlightingDone = true;
        }

        processGazeAndHighlight(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls, 'simple');
    }

    // Mode 2: Red/Gray scheme
    function highlightMode2(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls) {
        if (!window.eyeTrackingInitialHighlightingDone) {
            for (var i = 0; i < quadFreqs.length; i++) {
                var baseColor = colorLvls[0];
                var spanHandle = document.querySelector(`[id="${i}"].line`);
                if (spanHandle) {
                    spanHandle.style.backgroundColor = baseColor;

                    var freqs = dbQuadFreqs[i];
                    if (freqs && freqs.length >= 4) {
                        var normalisedFreq = freqs[0] + freqs[1] + (10 * freqs[2]) + (100 * freqs[3]);
                        var MAX = 450;
                        var percentRead = (normalisedFreq / MAX) * 100;

                        if (percentRead >= window.MIN_PERCENT_READ) {
                            var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[2]}, ${percentRead}%, ${colorLvls[0]})`;
                            spanHandle.style.background = backgroundCSS;
                            dbQuadFreqs[i].push(percentRead);
                        }
                        else {
                            dbQuadFreqs[i].push(0);
                        }
                    }
                }
            }
            window.eyeTrackingInitialHighlightingDone = true;
        }

        processGazeAndHighlight(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls, 'multi');
    }

    // Modes 3-10: Multi-color scheme
    function highlightModeMultiColor(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls) {
        if (!window.eyeTrackingInitialHighlightingDone) {
            for (var i = 0; i < quadFreqs.length; i++) {
                var baseColor = colorLvls[0];
                var spanHandle = document.querySelector(`[id="${i}"].line`);
                if (spanHandle) {
                    spanHandle.style.backgroundColor = baseColor;

                    var freqs = dbQuadFreqs[i];
                    if (freqs && freqs.length >= 4) {
                        var normalisedFreq = freqs[0] + freqs[1] + (10 * freqs[2]) + (100 * freqs[3]);
                        var MAX = 450;
                        var percentRead = (normalisedFreq / MAX) * 100;

                        if (percentRead >= window.MIN_PERCENT_READ) {
                            var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[2]}, ${percentRead}%, ${colorLvls[0]})`;
                            spanHandle.style.background = backgroundCSS;
                            dbQuadFreqs[i].push(percentRead);
                        }
                        else {
                            dbQuadFreqs[i].push(0);
                        }
                    }
                }
            }
            window.eyeTrackingInitialHighlightingDone = true;
        }

        processGazeAndHighlight(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls, 'multi');
    }

    // Common gaze processing and highlighting logic
    function processGazeAndHighlight(ws, quadFreqs, dbQuadFreqs, x, y, colorLvls, scheme) {
        var currQuadId = '';
        var currLineId = '';

        var el = document.elementFromPoint(x, y);
        if (el != null) {
            var isSpan = (el.nodeName.toLowerCase() == "span");
            var spanClassName = el.className;
            if (isSpan) {
                if (spanClassName == "quad") {
                    currQuadId = el.id;
                } else if (spanClassName == "line") {
                    currLineId = el.id;
                }
            }
        }

        var infoStr = '';

        if (currQuadId != '') {
            var quadNum = parseInt(currQuadId.charAt(0));
            var spanNum = parseInt(currQuadId.substr(1));
            var spanHandle = document.querySelector(`[id="${spanNum}"].line`);

            const t = (new Date()).getTime();
            infoStr = `${spanNum}|${quadNum}|${t}`;

            if (lineIsValid(window.lineQueue, spanNum)) {
                window.lineQueue.push(spanNum);
                if (window.lineQueue.length > window.QUEUE_LENGTH) {
                    window.lineQueue.shift();
                }

                quadFreqs[spanNum][quadNum] += 1;

                var freqs = quadFreqs[spanNum];
                var normalisedFreq = freqs[0] + freqs[1] + (10*freqs[2]) + (100 * freqs[3]);
                var MAX = 450;
                var percentRead = (normalisedFreq / MAX) * 100;
                
                if (percentRead >= window.MIN_PERCENT_READ && spanHandle) {
                    if (scheme === 'simple') {
                        var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[1]}, ${percentRead}%, ${colorLvls[0]})`;
                        spanHandle.style.background = backgroundCSS;
                    } else {
                        // Multi-color scheme with db comparison
                        var dbPercentRead = dbQuadFreqs[spanNum] && dbQuadFreqs[spanNum][4] ? Math.min(dbQuadFreqs[spanNum][4], 100) : 0;
                        if (percentRead > dbPercentRead) {
                            var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[3]}, ${dbPercentRead}%, ${colorLvls[1]}, ${percentRead}%, ${colorLvls[0]})`;
                            spanHandle.style.background = backgroundCSS;
                        }
                        else {
                            var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[3]}, ${percentRead}%, ${colorLvls[2]}, ${dbPercentRead}%, ${colorLvls[0]})`;
                            spanHandle.style.background = backgroundCSS;
                        }
                    }
                }
            }
        
        } else if (currLineId != '') {
            var lineNum = currLineId;
            var spanHandle = document.querySelector(`[id="${lineNum}"].line`);

            const t = (new Date()).getTime();
            infoStr = `${lineNum}|NA|${t}`;

            lineNum = parseInt(lineNum);

            if (lineIsValid(window.lineQueue, lineNum)) {
                window.lineQueue.push(lineNum);
                if (window.lineQueue.length > window.QUEUE_LENGTH) {
                    window.lineQueue.shift();
                }

                quadFreqs[lineNum][0] += 0.50;
                quadFreqs[lineNum][1] += 0.25;
                quadFreqs[lineNum][2] += 0.125;
                quadFreqs[lineNum][3] += 0.125;

                var freqs = quadFreqs[lineNum];
                var normalisedFreq = freqs[0] + freqs[1] + (10*freqs[2]) + (100 * freqs[3]);
                var MAX = 450;
                var percentRead = (normalisedFreq / MAX) * 100;

                if (percentRead >= window.MIN_PERCENT_READ && spanHandle) {
                    if (scheme === 'simple') {
                        var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[1]}, ${percentRead}%, ${colorLvls[0]})`;
                        spanHandle.style.background = backgroundCSS;
                    } else {
                        var dbPercentRead = dbQuadFreqs[lineNum] && dbQuadFreqs[lineNum][4] ? dbQuadFreqs[lineNum][4] : 0;
                        if (dbPercentRead == 0) {
                            var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[1]}, ${percentRead}%, ${colorLvls[0]})`;
                            spanHandle.style.background = backgroundCSS;
                        }
                        else {
                            var backgroundCSS = `linear-gradient(.25turn, ${colorLvls[3]}, ${percentRead}%, ${colorLvls[2]})`;
                            spanHandle.style.background = backgroundCSS;
                        }
                    }
                }
            }
                    
        } else {
            const t = (new Date()).getTime();
            infoStr = `-1|-1|${t}`;                        
        }

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(infoStr);
        }
    }

})();


