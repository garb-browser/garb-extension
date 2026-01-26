// GARB Extension Settings Manifest
this.manifest = {
    "name": "GARB Settings",
    "icon": "icon.png",
    "settings": [
        // ========== APPEARANCE TAB ==========
        {
            "tab": "Appearance",
            "group": "Highlight Color",
            "name": "highlightColor",
            "type": "popupButton",
            "label": "Color preset:",
            "options": {
                "values": [
                    { "value": "blue", "text": "Blue (Default)" },
                    { "value": "green", "text": "Green" },
                    { "value": "purple", "text": "Purple" },
                    { "value": "orange", "text": "Orange" },
                    { "value": "yellow", "text": "Yellow" },
                    { "value": "pink", "text": "Pink" },
                    { "value": "gray", "text": "Gray" }
                ]
            }
        },
        {
            "tab": "Appearance",
            "group": "Highlight Color",
            "name": "customColorEnabled",
            "type": "checkbox",
            "label": "Use custom color"
        },
        {
            "tab": "Appearance",
            "group": "Highlight Color",
            "name": "customColor",
            "type": "text",
            "label": "Custom color (hex):",
            "text": "e.g., #3b82f6"
        },
        {
            "tab": "Appearance",
            "group": "Highlight Style",
            "name": "highlightOpacity",
            "type": "slider",
            "label": "Highlight opacity:",
            "max": 100,
            "min": 10,
            "step": 5,
            "display": true,
            "displayModifier": function (value) {
                return value + "%";
            }
        },
        {
            "tab": "Appearance",
            "group": "Highlight Style",
            "name": "lineHighlightEnabled",
            "type": "checkbox",
            "label": "Show current line highlight"
        },
        {
            "tab": "Appearance",
            "group": "Gaze Indicator",
            "name": "showGazeIndicator",
            "type": "checkbox",
            "label": "Show gaze position indicator"
        },
        {
            "tab": "Appearance",
            "group": "Gaze Indicator",
            "name": "gazeIndicatorSize",
            "type": "slider",
            "label": "Indicator size:",
            "max": 60,
            "min": 20,
            "step": 5,
            "display": true,
            "displayModifier": function (value) {
                return value + "px";
            }
        },

        // ========== TRACKING TAB ==========
        {
            "tab": "Tracking",
            "group": "Calibration Offset",
            "name": "gazeYOffset",
            "type": "slider",
            "label": "Vertical offset (Y):",
            "max": 100,
            "min": -100,
            "step": 5,
            "display": true,
            "displayModifier": function (value) {
                return value + "px";
            }
        },
        {
            "tab": "Tracking",
            "group": "Calibration Offset",
            "name": "gazeXOffset",
            "type": "slider",
            "label": "Horizontal offset (X):",
            "max": 100,
            "min": -100,
            "step": 5,
            "display": true,
            "displayModifier": function (value) {
                return value + "px";
            }
        },
        {
            "tab": "Tracking",
            "group": "Calibration Offset",
            "name": "offsetDescription",
            "type": "description",
            "text": "Adjust these values if the highlight consistently appears above/below or left/right of where you're looking."
        },
        {
            "tab": "Tracking",
            "group": "Line Lock Sensitivity",
            "name": "lineLockTime",
            "type": "slider",
            "label": "Lock time:",
            "max": 500,
            "min": 100,
            "step": 25,
            "display": true,
            "displayModifier": function (value) {
                return value + "ms";
            }
        },
        {
            "tab": "Tracking",
            "group": "Line Lock Sensitivity",
            "name": "lineLockMargin",
            "type": "slider",
            "label": "Switch margin:",
            "max": 80,
            "min": 20,
            "step": 5,
            "display": true,
            "displayModifier": function (value) {
                return value + "px";
            }
        },
        {
            "tab": "Tracking",
            "group": "Line Lock Sensitivity",
            "name": "sensitivityDescription",
            "type": "description",
            "text": "Lock time: how long gaze must stay on new line before switching. Switch margin: instant switch if new line wins by this many pixels."
        },

        // ========== BEHAVIOR TAB ==========
        {
            "tab": "Behavior",
            "group": "Auto-Scroll",
            "name": "autoScrollEnabled",
            "type": "checkbox",
            "label": "Enable auto-scroll"
        },
        {
            "tab": "Behavior",
            "group": "Auto-Scroll",
            "name": "autoScrollSpeed",
            "type": "slider",
            "label": "Scroll speed:",
            "max": 200,
            "min": 50,
            "step": 10,
            "display": true,
            "displayModifier": function (value) {
                return value + "px/s";
            }
        },
        {
            "tab": "Behavior",
            "group": "Auto-Scroll",
            "name": "scrollMargin",
            "type": "slider",
            "label": "Scroll trigger margin:",
            "max": 200,
            "min": 50,
            "step": 10,
            "display": true,
            "displayModifier": function (value) {
                return value + "px";
            }
        },
        {
            "tab": "Behavior",
            "group": "Tracking Lost",
            "name": "trackingLostThreshold",
            "type": "slider",
            "label": "Tracking lost threshold:",
            "max": 5000,
            "min": 1000,
            "step": 250,
            "display": true,
            "displayModifier": function (value) {
                return (value / 1000).toFixed(1) + "s";
            }
        },
        {
            "tab": "Behavior",
            "group": "Tracking Lost",
            "name": "showResumeMarker",
            "type": "checkbox",
            "label": "Show resume marker when tracking lost"
        },

        // ========== ADVANCED TAB ==========
        {
            "tab": "Advanced",
            "group": "Smoothing",
            "name": "smoothingAlpha",
            "type": "slider",
            "label": "EMA smoothing factor:",
            "max": 0.8,
            "min": 0.1,
            "step": 0.05,
            "display": true,
            "displayModifier": function (value) {
                return value.toFixed(2);
            }
        },
        {
            "tab": "Advanced",
            "group": "Smoothing",
            "name": "smoothingDescription",
            "type": "description",
            "text": "Lower values = more smoothing (less jitter, more lag). Higher values = less smoothing (more responsive, more jitter)."
        },
        {
            "tab": "Advanced",
            "group": "Fixation Detection",
            "name": "fixationVelocityThreshold",
            "type": "slider",
            "label": "Velocity threshold:",
            "max": 60,
            "min": 10,
            "step": 5,
            "display": true,
            "displayModifier": function (value) {
                return value + "px/sample";
            }
        },
        {
            "tab": "Advanced",
            "group": "Fixation Detection",
            "name": "fixationMinDuration",
            "type": "slider",
            "label": "Minimum fixation duration:",
            "max": 200,
            "min": 50,
            "step": 10,
            "display": true,
            "displayModifier": function (value) {
                return value + "ms";
            }
        },
        {
            "tab": "Advanced",
            "group": "Reset",
            "name": "resetButton",
            "type": "button",
            "label": "Reset all settings:",
            "text": "Reset to Defaults"
        }
    ],
    "alignment": [
        ["gazeYOffset", "gazeXOffset"],
        ["lineLockTime", "lineLockMargin"],
        ["autoScrollSpeed", "scrollMargin"],
        ["fixationVelocityThreshold", "fixationMinDuration"]
    ]
};
