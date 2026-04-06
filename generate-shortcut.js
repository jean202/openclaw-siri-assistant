#!/usr/bin/env node
// Generates a Siri Shortcut (.shortcut) file for OpenClaw Siri Assistant
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

// --- UUIDs for action references ---
const getDeviceUUID = crypto.randomUUID().toUpperCase();
const askInputUUID = crypto.randomUUID().toUpperCase();
const getUrlUUID = crypto.randomUUID().toUpperCase();
const getValueUUID = crypto.randomUUID().toUpperCase();
const speakUUID = crypto.randomUUID().toUpperCase();

// --- Helper: text token (plain string) ---
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

// --- Helper: text token with variable reference ---
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

// --- Helper: JSON body field ---
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

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// --- Build Shortcut plist ---
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowActions</key>
  <array>

    <!-- Action 0: Get Device Name (for session identification) -->
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

    <!-- Action 1: Ask for Input (voice via Siri) -->
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

    <!-- Action 2: POST to /ask -->
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

    <!-- Action 3: Get "reply" from response -->
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

    <!-- Action 4: Speak the reply -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.speaktext</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${speakUUID}</string>
        <key>WFSpeakTextWait</key>
        <true/>
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
  // Fallback: rename XML as .shortcut (iOS can sometimes handle XML plist too)
  fs.renameSync(xmlPath, shortcutPath);
  console.warn("⚠️  plutil conversion failed, saved as XML plist (may still work)\n");
}

console.log("✅ Generated: AskOpenClaw.shortcut\n");
console.log("📱 Transfer to iPhone:");
console.log("   • AirDrop  — Right-click file → Share → AirDrop");
console.log("   • iCloud   — Copy to iCloud Drive, tap on iPhone");
console.log("   • Email    — Send as attachment, tap to open\n");
console.log("🗣️  Usage: \"Hey Siri, Ask OpenClaw\"\n");
console.log(`🔗 Tunnel URL: ${tunnelUrl}`);
console.log("   ⚠️  URL changes on restart — re-run this script after restart.\n");
