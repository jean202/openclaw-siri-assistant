#!/usr/bin/env node
// Generates a Siri Shortcut for hands-free Apple Music playback.
// Flow: ask for music -> POST /music -> get query -> Play Music.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync, execSync } = require("node:child_process");

const DIR = __dirname;
const shortcutPath = path.join(DIR, "PlayOpenClawMusic.shortcut");
const unsignedShortcutPath = path.join(DIR, "PlayOpenClawMusic-unsigned.shortcut");

function readEnvValue(key) {
  try {
    const envContent = fs.readFileSync(path.join(DIR, ".env"), "utf8");
    let value = "";
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const name = trimmed.slice(0, eqIdx).trim();
      if (name === key) value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
    }
    return value;
  } catch {
    return "";
  }
}

const musicService = readEnvValue("MUSIC_SERVICE").toLowerCase().replace(/[\s-]+/g, "_") || "apple_music";
if (["melon", "멜론"].includes(musicService)) {
  for (const filePath of [shortcutPath, unsignedShortcutPath]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
  console.log("MUSIC_SERVICE=melon");
  console.log("Skipping PlayOpenClawMusic.shortcut because it would play Apple Music.");
  console.log("Use the iPhone Shortcuts app to connect /music query to Melon's 음악검색하기 action.");
  process.exit(0);
}

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

const musicUrl = `${tunnelUrl}/music`;

const uuid = () => crypto.randomUUID().toUpperCase();
const getDeviceUUID = uuid();
const askInputUUID = uuid();
const postMusicUUID = uuid();
const getQueryUUID = uuid();
const ifQueryGroupUUID = uuid();
const playMusicUUID = uuid();
const speakErrorUUID = uuid();

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

    <!-- Ask for music request -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.ask</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${askInputUUID}</string>
        <key>WFAskActionPrompt</key>
        <string>What music should I play?</string>
        <key>WFInputType</key>
        <string>Text</string>
      </dict>
    </dict>

    <!-- POST to /music -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.downloadurl</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${postMusicUUID}</string>
        <key>WFURL</key>
        ${textToken(musicUrl)}
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

    <!-- Get query from response dictionary -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.getvalueforkey</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${getQueryUUID}</string>
        <key>WFDictionaryKey</key>
        <string>query</string>
      </dict>
    </dict>

    <!-- If query has any value -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.conditional</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${ifQueryGroupUUID}</string>
        <key>WFControlFlowMode</key>
        <integer>0</integer>
        <key>WFCondition</key>
        <integer>100</integer>
        <key>WFConditionalIfTrueActions</key>
        <array/>
        <key>WFInput</key>
        ${actionRef("Dictionary Value", getQueryUUID)}
      </dict>
    </dict>

    <!-- Play Music using the query value as input -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.playmusic</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>UUID</key>
        <string>${playMusicUUID}</string>
        <key>WFInput</key>
        ${actionRef("Dictionary Value", getQueryUUID)}
        <key>WFPlayMusicActionShuffle</key>
        <string>Off</string>
        <key>WFPlayMusicActionRepeat</key>
        <string>None</string>
      </dict>
    </dict>

    <!-- Otherwise -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.conditional</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${ifQueryGroupUUID}</string>
        <key>WFControlFlowMode</key>
        <integer>1</integer>
      </dict>
    </dict>

    <!-- Speak error -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.speaktext</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>WFSpeakTextWait</key>
        <true/>
        <key>WFText</key>
        ${textToken("Sorry, I could not find music to play.")}
        <key>UUID</key>
        <string>${speakErrorUUID}</string>
      </dict>
    </dict>

    <!-- End If -->
    <dict>
      <key>WFWorkflowActionIdentifier</key>
      <string>is.workflow.actions.conditional</string>
      <key>WFWorkflowActionParameters</key>
      <dict>
        <key>GroupingIdentifier</key>
        <string>${ifQueryGroupUUID}</string>
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
    <integer>61441</integer>
    <key>WFWorkflowIconStartColor</key>
    <integer>4292093695</integer>
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

const xmlPath = path.join(DIR, "PlayOpenClawMusic.plist");
fs.writeFileSync(xmlPath, plist, "utf8");

try {
  execSync(`plutil -convert binary1 -o "${unsignedShortcutPath}" "${xmlPath}"`);
  fs.unlinkSync(xmlPath);
} catch {
  fs.renameSync(xmlPath, unsignedShortcutPath);
  console.warn("plutil conversion failed, saved as XML plist (may still work)\n");
}

let signedShortcutGenerated = false;
try {
  execFileSync("shortcuts", [
    "sign",
    "--mode",
    "anyone",
    "--input",
    unsignedShortcutPath,
    "--output",
    shortcutPath,
  ]);
  signedShortcutGenerated = true;
} catch {
  fs.copyFileSync(unsignedShortcutPath, shortcutPath);
  console.warn("Signing failed. PlayOpenClawMusic.shortcut is unsigned and may not import on iOS.\n");
}

console.log("Generated: PlayOpenClawMusic.shortcut");
console.log("Generated source file: PlayOpenClawMusic-unsigned.shortcut\n");
if (signedShortcutGenerated) {
  console.log("PlayOpenClawMusic.shortcut is signed for iOS import.\n");
}
console.log("Transfer to iPhone and rename it to your Siri phrase, for example: Music please");
console.log(`Endpoint: ${musicUrl}`);
