#!/usr/bin/env node
// Generates a Siri Shortcut (.shortcut) file for OpenClaw Siri Assistant
// Features: error handling with voice feedback, follow-up conversation loop
// Usage: node generate-shortcut.js

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const DIR = __dirname;

// --- Read current config ---
let tunnelUrl, secret;
try {
  tunnelUrl = fs.readFileSync(path.join(DIR, ".tunnel-url"), "utf8").trim();
} catch {
  console.error("ERROR: .tunnel-url not found. Start the bridge first (./start.sh)");
  process.exit(1);
}
try {
  secret = fs.readFileSync(path.join(DIR, ".secret"), "utf8").trim();
} catch {
  console.error("ERROR: .secret not found. Start the bridge first (./start.sh)");
  process.exit(1);
}

const askUrl = `${tunnelUrl}/ask`;

// --- UUIDs ---
const uuid = () => crypto.randomUUID().toUpperCase();
const getDeviceUUID = uuid();
const repeatGroupUUID = uuid();
const askInputUUID = uuid();
const getUrlUUID = uuid();
const getValueUUID = uuid();
const ifReplyGroupUUID = uuid();
const speakReplyUUID = uuid();
const speakErrorUUID = uuid();

// --- XML helpers ---
function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textToken(str) {
  return `<dict>
              <key>WFSerializationType</key>
              <string>WFTextTokenString</string>
              <key>Value</key>
              <dict>
                <key>string</key>
                <string>${escapeXml(str)}</string>
                <key>attachmentsByRange</key>
                <dict/>
              </dict>
            </dict>`;
}

function textTokenWithVar(outputName, outputUUID) {
  return `<dict>
              <key>WFSerializationType</key>
              <string>WFTextTokenString</string>
              <key>Value</key>
              <dict>
                <key>string</key>
                <string>\uFFFC</string>
                <key>attachmentsByRange</key>
                <dict>
                  <key>{0, 1}</key>
                  <dict>
                    <key>OutputName</key>
                    <string>${escapeXml(outputName)}</string>
                    <key>OutputUUID</key>
                    <string>${outputUUID}</string>
                    <key>Type</key>
                    <string>ActionOutput</string>
                  </dict>
                </dict>
              </dict>
            </dict>`;
}

function jsonField(key, valueXml) {
  return `<dict>
                <key>WFItemType</key>
                <integer>0</integer>
                <key>WFKey</key>
                ${textToken(key)}
                <key>WFValue</key>
                ${valueXml}
              </dict>`;
}

function actionRef(outputName, outputUUID) {
  return `<dict>
        <key>Value</key>
        <dict>
          <key>OutputName</key>
          <string>${escapeXml(outputName)}</string>
          <key>OutputUUID</key>
          <string>${outputUUID}</string>
          <key>Type</key>
          <string>ActionOutput</string>
        </dict>
        <key>WFSerializationType</key>
        <string>WFActionOutputVariable</string>
      </dict>`;
}

// --- Build Shortcut plist ---
// Flow:
//   0. Get Device Name (session ID)
//   1. Repeat 20 times (conversation loop)
//     2. Ask for Input
//     3. POST /ask
//     4. Get "reply" from JSON
//     5. If reply has value → Speak reply
//     6. Otherwise → Speak error message
//   7. End Repeat

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowActions</key>
  <array>

    <!-- Get Device Name -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.getdevicedetails</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${getDeviceUUID}</string>
        <key>WFDeviceDetail</key>
        <string>Device Name</string>
      </dict>
    </dict>

    <!-- Repeat Start (conversation loop, max 20 turns) -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.repeat.count</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${repeatGroupUUID}</string>
        <key>WFControlFlowMode</key>
        <integer>0</integer>
        <key>WFRepeatCount</key>
        <integer>20</integer>
      </dict>
    </dict>

    <!-- Ask for Input -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.ask</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${askInputUUID}</string>
        <key>WFAskActionPrompt</key>
        <string>What would you like to ask?</string>
        <key>WFInputType</key>
        <string>Text</string>
      </dict>
    </dict>

    <!-- POST to /ask -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${getUrlUUID}</string>
        <key>WFURL</key>
        ${textToken(askUrl)}
        <key>WFHTTPMethod</key>
        <string>POST</string>
        <key>WFHTTPBodyType</key>
        <string>JSON</string>
        <key>WFJSONValues</key>
        <dict>
          <key>WFSerializationType</key>
          <string>WFDictionaryFieldValue</string>
          <key>Value</key>
          <dict>
            <key>WFDictionaryFieldValueItems</key>
            <array>
              ${jsonField("secret", textToken(secret))}
              ${jsonField("message", textTokenWithVar("Provided Input", askInputUUID))}
              ${jsonField("session_id", textTokenWithVar("Device Details", getDeviceUUID))}
            </array>
          </dict>
        </dict>
      </dict>
    </dict>

    <!-- Get "reply" from response dictionary -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.getvalueforkey</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${getValueUUID}</string>
        <key>WFDictionaryKey</key>
        <string>reply</string>
      </dict>
    </dict>

    <!-- If: reply has any value -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.conditional</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${ifReplyGroupUUID}</string>
        <key>WFControlFlowMode</key>
        <integer>0</integer>
        <key>WFCondition</key>
        <integer>100</integer>
        <key>WFConditionalIfTrueActions</key>
        <array/>
        <key>WFInput</key>
        ${actionRef("Dictionary Value", getValueUUID)}
      </dict>
    </dict>

    <!-- Speak error (reply is empty/missing) -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.speaktext</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${speakErrorUUID}</string>
        <key>WFSpeakTextWait</key>
        <true/>
        <key>WFText</key>
        ${textToken("Sorry, I couldn't get a response from the server. Please try again later.")}
      </dict>
    </dict>

    <!-- Otherwise (reply exists) — Speak reply -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.conditional</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${ifReplyGroupUUID}</string>
        <key>WFControlFlowMode</key>
        <integer>1</integer>
      </dict>
    </dict>

    <!-- Speak the reply -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.speaktext</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${speakReplyUUID}</string>
        <key>WFSpeakTextWait</key>
        <true/>
        <key>WFText</key>
        ${textTokenWithVar("Dictionary Value", getValueUUID)}
      </dict>
    </dict>

    <!-- End If -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.conditional</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${ifReplyGroupUUID}</string>
        <key>WFControlFlowMode</key>
        <integer>2</integer>
      </dict>
    </dict>

    <!-- End Repeat -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.repeat.count</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${repeatGroupUUID}</string>
        <key>WFControlFlowMode</key>
        <integer>2</integer>
      </dict>
    </dict>

  </array>

  <key>WFWorkflowClientVersion</key>
  <string>2612.0.4</string>
  <key>WFWorkflowHasOutputFallback</key>
  <false/>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconGlyphNumber</key>
    <integer>59749</integer>
    <key>WFWorkflowIconStartColor</key>
    <integer>4282601983</integer>
  </dict>
  <key>WFWorkflowImportQuestions</key>
  <array/>
  <key>WFWorkflowInputContentItemClasses</key>
  <array>
    <string>WFStringContentItem</string>
  </array>
  <key>WFWorkflowMinimumClientVersion</key>
  <integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key>
  <string>900</string>
  <key>WFWorkflowOutputContentItemClasses</key>
  <array/>
  <key>WFWorkflowTypes</key>
  <array>
    <string>NCWidget</string>
    <string>WatchKit</string>
  </array>
</dict>
</plist>`;

// --- Write and convert ---
const xmlPath = path.join(DIR, "AskOpenClaw.plist");
const shortcutPath = path.join(DIR, "AskOpenClaw.shortcut");

fs.writeFileSync(xmlPath, plist, "utf8");

try {
  execSync(`plutil -convert binary1 -o "${shortcutPath}" "${xmlPath}"`);
  fs.unlinkSync(xmlPath);
} catch (e) {
  fs.renameSync(xmlPath, shortcutPath);
  console.warn("plutil conversion failed, saved as XML plist (may still work)\n");
}

console.log("Generated: AskOpenClaw.shortcut\n");
console.log("Transfer to iPhone:");
console.log("  AirDrop  — Right-click file > Share > AirDrop");
console.log("  iCloud   — Copy to iCloud Drive, tap on iPhone\n");
console.log(`Usage: "Hey Siri, Ask OpenClaw"\n`);
console.log("Features:");
console.log("  - Follow-up conversation (up to 20 turns per session)");
console.log("  - Error handling with voice feedback");
console.log("  - Device-based session tracking\n");
console.log(`Tunnel URL: ${tunnelUrl}`);
if (!tunnelUrl.includes("trycloudflare")) {
  console.log("  (Fixed URL — no need to regenerate)\n");
} else {
  console.log("  URL changes on restart — shortcut auto-regenerates.\n");
}
