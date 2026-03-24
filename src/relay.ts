/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");
const PULSEOS_URL = process.env.PULSEOS_URL || "http://localhost:3000";

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  // Enable tools: web search, read, bash, etc.
  args.push("--allowedTools", "WebSearch", "WebFetch", "Read", "Bash", "Glob", "Grep", "Edit", "Write");

  args.push("--output-format", "json");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        // Pass through any env vars Claude might need
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Parse JSON output to extract session ID and response text
    try {
      const jsonOutput = JSON.parse(output);
      // Save session ID for conversation continuity
      if (jsonOutput.session_id) {
        session.sessionId = jsonOutput.session_id;
        session.lastActivity = new Date().toISOString();
        await saveSession(session);
        console.log(`Session saved: ${session.sessionId}`);
      }
      // Extract text from the result - handle both array and string formats
      if (typeof jsonOutput.result === "string") {
        return jsonOutput.result.trim();
      }
      if (Array.isArray(jsonOutput.result)) {
        return jsonOutput.result
          .filter((block: any) => block.type === "text")
          .map((block: any) => block.text)
          .join("\n")
          .trim();
      }
      // Fallback: return raw text content
      return jsonOutput.result?.text || output.trim();
    } catch {
      // If JSON parse fails, fall back to text output
      const sessionMatch = output.match(/Session ID: ([a-f0-9-]+)/i);
      if (sessionMatch) {
        session.sessionId = sessionMatch[1];
        session.lastActivity = new Date().toISOString();
        await saveSession(session);
      }
      return output.trim();
    }
  } catch (error) {
    console.error("Spawn error:", error);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// PULSEOS BRIDGE
// ============================================================

async function mirrorToPulseOS(from: 'user' | 'agent', text: string): Promise<void> {
  try {
    await fetch(`${PULSEOS_URL}/api/chat-mirror`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, text, source: 'telegram', time: new Date().toISOString() })
    });
  } catch {
    // PulseOS offline — silently ignore
  }
}

// Poll PulseOS dashboard outbox for messages sent from the browser UI
async function pollDashboardOutbox(): Promise<void> {
  while (true) {
    try {
      const res = await fetch(`${PULSEOS_URL}/api/chat-outbox`);
      const data = await res.json() as { messages: Array<{ id: string; message: string; source: string }> };
      if (data.messages?.length > 0) {
        for (const msg of data.messages) {
          console.log(`[PulseOS] Dashboard message: ${msg.message.substring(0, 50)}...`);
          proactiveState.lastUserMessage = Date.now();

          // Load chat history for context + PulseOS context
          let chatContext = "";
          try {
            const histRes = await fetch(`${PULSEOS_URL}/api/chat-history`);
            const hist = await histRes.json() as { messages: Array<{ from: string; text: string }> };
            const recent = (hist.messages || []).slice(-20);
            if (recent.length > 0) {
              chatContext = "\n\n## Vorheriger Chat-Verlauf (Dashboard):\n" +
                recent.map(m => `${m.from === 'agent' ? 'Du' : 'User'}: ${m.text}`).join("\n");
            }
          } catch {}

          const [relevantContext, memoryContext] = await Promise.all([
            getRelevantContext(supabase, msg.message),
            getMemoryContext(supabase),
          ]);

          const enrichedPrompt = buildPrompt(msg.message, relevantContext, memoryContext, chatContext);
          console.log(`[Dashboard] Calling Claude for: ${msg.message.substring(0, 50)}...`);
          const rawResponse = await callClaude(enrichedPrompt, { resume: true });
          console.log(`[Dashboard] Raw response: ${rawResponse.substring(0, 100)}...`);
          const response = await processMemoryIntents(supabase, rawResponse);
          console.log(`[Dashboard] Clean response: ${response.substring(0, 100)}...`);

          await saveMessage("user", `[Dashboard]: ${msg.message}`);
          await saveMessage("assistant", response);
          console.log(`[Dashboard] Mirroring to PulseOS...`);
          await mirrorToPulseOS('agent', response);
          console.log(`[Dashboard] Mirrored OK`);

          // Forward to Telegram so the conversation is visible there too
          try {
            await bot.api.sendMessage(ALLOWED_USER_ID, `💻 *Dashboard:* ${msg.message}`, { parse_mode: "Markdown" });
            await bot.api.sendMessage(ALLOWED_USER_ID, response);
            console.log(`[Dashboard] Forwarded to Telegram OK`);
          } catch (e) { console.error("[PulseOS→TG] Forward failed:", e); }
        }
      }
    } catch {
      // PulseOS offline
    }
    await Bun.sleep(5000);
  }
}

// Start outbox polling in background
pollDashboardOutbox();

// ============================================================
// PROACTIVE AGENT SCHEDULER
// ============================================================

const proactiveState = {
  lastBriefingDate: '',
  lastCheckinTime: 0,
  checkinCount: 0,
  checkinDate: '',
  lastUserMessage: Date.now(),
};

async function sendProactiveMessage(text: string, type: 'briefing' | 'checkin' | 'alert'): Promise<void> {
  const prefix = type === 'briefing' ? '☀️' : type === 'checkin' ? '💡' : '🔔';
  const fullText = `${prefix} ${text}`;
  try {
    await bot.api.sendMessage(ALLOWED_USER_ID, fullText);
  } catch (e) { console.error(`[Proactive→TG] Send failed:`, e); }
  await mirrorToPulseOS('agent', fullText);
  // Also send as agent-alert for Agent-Bar pulsing
  try {
    await fetch(`${PULSEOS_URL}/api/agent-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: fullText, type, source: 'claudeos' })
    });
  } catch { /* PulseOS offline */ }
  await saveMessage('assistant', `[${type}] ${text}`);
  console.log(`[Proactive] Sent ${type}: ${text.substring(0, 60)}...`);
}

async function checkMorningBriefing(): Promise<void> {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const today = now.toISOString().slice(0, 10);

  // Only trigger between 8:55 and 9:05, once per day
  if (hours !== 9 && !(hours === 8 && minutes >= 55)) return;
  if (hours === 9 && minutes > 5) return;
  if (proactiveState.lastBriefingDate === today) return;

  proactiveState.lastBriefingDate = today;
  console.log('[Proactive] Triggering morning briefing...');

  try {
    // Refresh context to get latest data
    await refreshPulseOSContext();

    const briefingPrompt = [
      'Erstelle ein kurzes, freundliches Morning Briefing für den User.',
      'Fasse zusammen was heute ansteht basierend auf dem PulseOS-Kontext.',
      'Halte es unter 200 Wörtern. Erwähne: anstehende Tasks, Kalender-Events, offene Goals.',
      'Wenn nichts ansteht, wünsche einfach einen guten Tag.',
      `Current time: ${now.toLocaleString('de-DE', { timeZone: USER_TIMEZONE, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`,
    ];
    if (pulseOSContext) briefingPrompt.push(`\n${pulseOSContext}`);

    const rawResponse = await callClaude(briefingPrompt.join('\n'));
    const response = await processMemoryIntents(supabase, rawResponse);
    await sendProactiveMessage(response, 'briefing');
  } catch (e) {
    console.error('[Proactive] Briefing failed:', e);
  }
}

async function checkSmartCheckin(): Promise<void> {
  const now = new Date();
  const hours = now.getHours();
  const today = now.toISOString().slice(0, 10);

  // Reset daily counter
  if (proactiveState.checkinDate !== today) {
    proactiveState.checkinDate = today;
    proactiveState.checkinCount = 0;
  }

  // Quiet hours: no check-ins between 22:00 and 8:00
  if (hours < 8 || hours >= 22) return;

  // Max 3 check-ins per day
  if (proactiveState.checkinCount >= 3) return;

  // Only check in if user has been inactive for 2+ hours
  const inactiveMs = Date.now() - proactiveState.lastUserMessage;
  if (inactiveMs < 2 * 60 * 60 * 1000) return;

  // Minimum 30 min between check-ins
  if (Date.now() - proactiveState.lastCheckinTime < 30 * 60 * 1000) return;

  console.log('[Proactive] Evaluating smart check-in...');

  try {
    await refreshPulseOSContext();

    const checkinPrompt = [
      'Du bist ein proaktiver Assistent. Entscheide ob du den User jetzt kontaktieren solltest.',
      'Antworte NUR mit einem JSON-Objekt: {"shouldCheckin": true/false, "message": "deine Nachricht"}',
      'Gründe für Check-in: Deadline naht, offener Task seit Tagen, Meeting bald, ein freundlicher Check-in, oder ein Automatisierungs-Vorschlag.',
      'Gründe dagegen: Nichts Dringendes, bereits heute gecheckt, User ist wahrscheinlich beschäftigt.',
      'Wenn du Muster erkennst (z.B. User checkt täglich Wetter/Tasks), schlage einen Graph vor: "Du checkst regelmäßig X — soll ich das automatisieren?"',
      `Der User war seit ${Math.round(inactiveMs / 60000)} Minuten inaktiv.`,
      `Heutige Check-ins bisher: ${proactiveState.checkinCount}`,
      `Aktuelle Zeit: ${now.toLocaleString('de-DE', { timeZone: USER_TIMEZONE, hour: '2-digit', minute: '2-digit', weekday: 'long' })}`,
    ];
    if (pulseOSContext) checkinPrompt.push(`\nPulseOS-Kontext:\n${pulseOSContext}`);

    const rawResponse = await callClaude(checkinPrompt.join('\n'));

    try {
      // Extract JSON from response (might have markdown wrapping)
      const jsonMatch = rawResponse.match(/\{[\s\S]*"shouldCheckin"[\s\S]*\}/);
      if (jsonMatch) {
        const decision = JSON.parse(jsonMatch[0]);
        if (decision.shouldCheckin && decision.message) {
          proactiveState.checkinCount++;
          proactiveState.lastCheckinTime = Date.now();
          await sendProactiveMessage(decision.message, 'checkin');
        } else {
          console.log('[Proactive] Check-in skipped (Claude decided not to)');
        }
      }
    } catch {
      console.log('[Proactive] Could not parse check-in decision');
    }
  } catch (e) {
    console.error('[Proactive] Check-in failed:', e);
  }
}

// Run checks periodically
setInterval(checkMorningBriefing, 60_000);   // Every minute (checks time internally)
setInterval(checkSmartCheckin, 30 * 60_000); // Every 30 minutes

// ── Agent Presence Heartbeat ──
async function sendHeartbeat(): Promise<void> {
  try {
    await fetch(`${PULSEOS_URL}/api/agent-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'claudeos', type: 'chat', model: 'opus' })
    });
  } catch { /* PulseOS offline */ }
}
sendHeartbeat();
setInterval(sendHeartbeat, 30_000); // Every 30 seconds

// ── Sync Memories to PulseOS ──
async function syncMemoriesToPulseOS(): Promise<void> {
  if (!supabase) return;
  try {
    const [factsResult, goalsResult] = await Promise.all([
      supabase.rpc("get_facts"),
      supabase.rpc("get_active_goals"),
    ]);
    const memories = {
      facts: (factsResult.data || []).map((f: any) => ({ content: f.content, id: f.id })),
      goals: (goalsResult.data || []).map((g: any) => ({ content: g.content, deadline: g.deadline, id: g.id })),
      synced: new Date().toISOString()
    };
    await fetch(`${PULSEOS_URL}/api/agent-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(memories)
    });
    console.log(`[Memory] Synced ${memories.facts.length} facts, ${memories.goals.length} goals to PulseOS`);
  } catch { /* PulseOS offline or no Supabase */ }
}
syncMemoriesToPulseOS();
setInterval(syncMemoriesToPulseOS, 5 * 60_000); // Every 5 minutes

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  await saveMessage("user", text);
  proactiveState.lastUserMessage = Date.now();

  // Mirror user message to PulseOS IMMEDIATELY (before Claude processes)
  await mirrorToPulseOS('user', text);

  // PulseOS context is cached (refreshed every 5 min via interval) — no per-message refresh needed
  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
  ]);

  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext);
  const rawResponse = await callClaude(enrichedPrompt, { resume: true });

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);
  await sendResponse(ctx, response);

  // Mirror agent response to PulseOS
  await mirrorToPulseOS('agent', response);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);
    await mirrorToPulseOS('user', `[Voice]: ${transcription}`);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext
    );
    const rawResponse = await callClaude(enrichedPrompt, { resume: true });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
    await mirrorToPulseOS('agent', claudeResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);
    await mirrorToPulseOS('user', `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
    await mirrorToPulseOS('agent', cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);
    await mirrorToPulseOS('user', `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, { resume: true });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
    await mirrorToPulseOS('agent', cleanResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

// Load PulseOS context dynamically (refreshed every 5 min)
let pulseOSContext = "";
let pulseOSContextHash = "";
let pulseOSContextSentInSession = false;
async function refreshPulseOSContext(): Promise<void> {
  try {
    const res = await fetch(`${PULSEOS_URL}/api/agent-context`);
    const data = await res.json() as { context: string };
    const newContext = data.context || "";
    const newHash = Bun.hash(newContext).toString();
    if (newHash !== pulseOSContextHash) {
      pulseOSContext = newContext;
      pulseOSContextHash = newHash;
      pulseOSContextSentInSession = false; // force re-send on next message
      console.log(`[PulseOS] Context changed (${pulseOSContext.length} chars)`);
    } else {
      console.log(`[PulseOS] Context unchanged (${pulseOSContext.length} chars)`);
    }
  } catch {
    console.log("[PulseOS] Not reachable — context unavailable");
    pulseOSContext = "";
    pulseOSContextHash = "";
  }
}
await refreshPulseOSContext();
setInterval(refreshPulseOSContext, 5 * 60 * 1000);

// ── KPI Alert Check ──
let lastKpiCheck = '';
async function checkKPIAlerts(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (lastKpiCheck === today) return; // Once per day
  const hours = new Date().getHours();
  if (hours < 9 || hours >= 22) return; // Only after morning briefing

  try {
    const res = await fetch(`${PULSEOS_URL}/api/activity-summary?days=7`);
    const data = await res.json() as { staleApps: string[]; activity: Array<{ name: string; daysAgo: number }> };
    const alerts: string[] = [];

    if (data.staleApps?.length >= 3) {
      alerts.push(`${data.staleApps.length} Apps seit 3+ Tagen inaktiv: ${data.staleApps.slice(0, 3).join(', ')}`);
    }

    try {
      const tasksRes = await fetch(`${PULSEOS_URL}/app/tasks/api/tasks`);
      const td = await tasksRes.json() as { tasks: Array<{ done?: boolean; completed?: boolean; dueDate?: string; text?: string }> };
      const overdue = (td.tasks || []).filter((t: any) => !t.done && !t.completed && t.dueDate && new Date(t.dueDate) < new Date());
      if (overdue.length > 0) {
        alerts.push(`${overdue.length} \u00fcberf\u00e4llige Tasks: ${overdue.slice(0, 2).map((t: any) => t.text || '?').join(', ')}`);
      }
    } catch {}

    if (alerts.length > 0) {
      lastKpiCheck = today;
      await sendProactiveMessage(alerts.join('\n'), 'alert');
    }
  } catch {}
}
setInterval(checkKPIAlerts, 60 * 60_000);

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string,
  chatHistory?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
    "Du bist proaktiv — wenn du merkst dass der User Hilfe brauchen könnte (Deadline naht, Task vergessen, Meeting bald), weise dezent darauf hin. Maximal 2-3 proaktive Hinweise pro Tag. Sei hilfreich, nicht nervig.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  // Only include full PulseOS context on first message or when context changed (--resume keeps session state)
  if (pulseOSContext && !pulseOSContextSentInSession) {
    parts.push(`\n${pulseOSContext}`);
    pulseOSContextSentInSession = true;
  } else if (pulseOSContext) {
    parts.push(`\n[PulseOS context already loaded in this session — use cached knowledge. API base: ${PULSEOS_URL}]`);
  }
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  if (chatHistory) parts.push(chatHistory);
  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
