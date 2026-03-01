const express = require('express');
const { execSync, exec, execFileSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 4200);
const REGISTRY_FILE = path.join(__dirname, '.agent-registry.json');
const AGENT_PROFILE_FILE = path.join(__dirname, 'config', 'agents.json');
const POLL_INTERVAL = 3000;
const SPAWN_PREFIX = 'agent-';

const API_PASSWORD = process.env.AGENT_VIEWER_PASSWORD || 'agent-viewer';
if (!process.env.AGENT_VIEWER_PASSWORD) {
  console.warn('[AUTH] AGENT_VIEWER_PASSWORD 未设置，当前使用默认密码: agent-viewer');
}

const STATUS_MODES = new Set(['heuristic', 'file_sentinel', 'webhook', 'hybrid']);

const DEFAULT_AGENT_PROFILES = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    defaultArgs: ['--chrome', '--dangerously-skip-permissions'],
    detect: { processRegex: '(?:^|/)claude(?:\\s|$)' },
    readiness: {
      type: 'prompt_regex',
      pattern: '^>\\s*$|^❯\\s*$|^❯\\s+\\S',
      timeoutMs: 30000,
      autoDismissClaudePrompts: true,
    },
    status: {
      mode: 'heuristic',
      filePathTemplate: '${projectPath}/.agent-status.json',
    },
    systemInitPrompt: '',
  },
  {
    id: 'codex',
    displayName: 'OpenAI Codex CLI',
    command: 'codex',
    defaultArgs: [],
    detect: { processRegex: '(?:^|/)codex(?:\\s|$)' },
    readiness: {
      type: 'prompt_regex',
      pattern: '^>\\s*$|^❯\\s*$|^❯\\s+\\S',
      timeoutMs: 30000,
    },
    status: {
      mode: 'heuristic',
      filePathTemplate: '${projectPath}/.agent-status.json',
    },
    systemInitPrompt: '',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode CLI',
    command: 'opencode',
    defaultArgs: [],
    detect: { processRegex: '(?:^|/)opencode(?:\\s|$)' },
    readiness: {
      type: 'prompt_regex',
      pattern: '^>\\s*$|^❯\\s*$|^❯\\s+\\S',
      timeoutMs: 30000,
    },
    status: {
      mode: 'heuristic',
      filePathTemplate: '${projectPath}/.agent-status.json',
    },
    systemInitPrompt: '',
  },
];

let registry = {};
let agentProfiles = [];
let agentProfileMap = new Map();
const nonAgentCache = new Map();

function randomSecret() {
  return crypto.randomBytes(16).toString('hex');
}

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Failed to load registry:', e.message);
    registry = {};
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
  } catch (e) {
    console.error('Failed to save registry:', e.message);
  }
}

function ensureConfigDir() {
  const dir = path.dirname(AGENT_PROFILE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeProfile(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null;

  const id = String(raw.id || fallbackId || '').trim().toLowerCase();
  const command = String(raw.command || '').trim();
  if (!id || !command) return null;

  const displayName = String(raw.displayName || id).trim();
  const defaultArgs = Array.isArray(raw.defaultArgs)
    ? raw.defaultArgs.filter(v => typeof v === 'string')
    : [];

  const detectRegex = raw.detect && typeof raw.detect.processRegex === 'string'
    ? raw.detect.processRegex
    : `(?:^|/)${escapeRegex(path.basename(command))}(?:\\s|$)`;

  const readiness = {
    type: raw.readiness && typeof raw.readiness.type === 'string' ? raw.readiness.type : 'prompt_regex',
    pattern: raw.readiness && typeof raw.readiness.pattern === 'string' ? raw.readiness.pattern : '^>\\s*$|^❯\\s*$|^❯\\s+\\S',
    timeoutMs: raw.readiness && Number.isFinite(Number(raw.readiness.timeoutMs))
      ? Number(raw.readiness.timeoutMs)
      : 30000,
    autoDismissClaudePrompts: Boolean(raw.readiness && raw.readiness.autoDismissClaudePrompts),
  };

  const statusMode = raw.status && typeof raw.status.mode === 'string' ? raw.status.mode : 'heuristic';
  const status = {
    mode: STATUS_MODES.has(statusMode) ? statusMode : 'heuristic',
    filePathTemplate: raw.status && typeof raw.status.filePathTemplate === 'string'
      ? raw.status.filePathTemplate
      : '${projectPath}/.agent-status.json',
  };

  const env = raw.env && typeof raw.env === 'object' ? raw.env : {};
  const systemInitPrompt = typeof raw.systemInitPrompt === 'string' ? raw.systemInitPrompt : '';

  return {
    id,
    displayName,
    command,
    defaultArgs,
    detect: { processRegex: detectRegex },
    readiness,
    status,
    env,
    systemInitPrompt,
  };
}

function loadAgentProfiles() {
  ensureConfigDir();

  let source = null;
  if (fs.existsSync(AGENT_PROFILE_FILE)) {
    try {
      source = JSON.parse(fs.readFileSync(AGENT_PROFILE_FILE, 'utf-8'));
    } catch (e) {
      console.error('[PROFILE] 配置文件解析失败，将使用默认配置:', e.message);
    }
  }

  let list = [];
  if (Array.isArray(source)) list = source;
  if (source && Array.isArray(source.profiles)) list = source.profiles;
  if (list.length === 0) list = DEFAULT_AGENT_PROFILES;

  const normalized = [];
  for (let i = 0; i < list.length; i++) {
    const p = normalizeProfile(list[i], `profile-${i + 1}`);
    if (p) normalized.push(p);
  }

  if (normalized.length === 0) {
    normalized.push(...DEFAULT_AGENT_PROFILES.map(p => normalizeProfile(p)).filter(Boolean));
  }

  agentProfiles = normalized;
  agentProfileMap = new Map(agentProfiles.map(p => [p.id, p]));

  const output = { profiles: agentProfiles };
  fs.writeFileSync(AGENT_PROFILE_FILE, JSON.stringify(output, null, 2));
}

function getAgentProfile(agentId) {
  if (!agentId) return agentProfiles[0] || null;
  return agentProfileMap.get(String(agentId).toLowerCase()) || null;
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripAnsi(str) {
  return String(str || '')
    .replace(/\x1B(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\([A-Z0-9])/g, '')
    .replace(/\x1B\[[\?]?[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1B[^[\]()][^\x1B]*/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function isSafeInputText(str) {
  if (typeof str !== 'string') return false;
  if (str.length > 1000) return false;
  return !/[\x00]/.test(str);
}

function validateArgs(args) {
  if (!Array.isArray(args)) return [];
  if (args.length > 40) throw new Error('agentArgs 最多 40 个');

  const normalized = [];
  for (const arg of args) {
    if (typeof arg !== 'string') throw new Error('agentArgs 必须为字符串数组');
    if (arg.length > 400) throw new Error('单个参数长度不能超过 400');
    if (/[\x00]/.test(arg)) throw new Error('参数包含非法字符');
    normalized.push(arg);
  }
  return normalized;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf-8');
  const bb = Buffer.from(String(b || ''), 'utf-8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function authMiddleware(req, res, next) {
  const actual = req.headers['x-agent-viewer-password'] || req.query.password || '';
  if (!timingSafeEqual(actual, API_PASSWORD)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.use('/api', authMiddleware);

function tmux(args, timeout = 5000) {
  return execFileSync('tmux', args, {
    encoding: 'utf-8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tmuxSafe(args, timeout = 5000) {
  try {
    return tmux(args, timeout);
  } catch {
    return '';
  }
}

function shellEscape(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function buildLaunchCommand(command, args) {
  const tokens = [command, ...(args || [])];
  return tokens.map(shellEscape).join(' ');
}

function expandTemplate(template, vars) {
  return String(template || '').replace(/\$\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    if (vars[key] === undefined || vars[key] === null) return '';
    return String(vars[key]);
  });
}

function normalizeProjectPath(projectPath) {
  let p = String(projectPath || '').trim();
  if (!p) throw new Error('projectPath 不能为空');
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  p = path.resolve(p);
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
    throw new Error(`Project path does not exist: ${p}`);
  }
  return p;
}

function normalizeState(raw, fallback = 'running') {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'running' || s === 'idle' || s === 'completed' || s === 'failed') return s;
  if (s === 'error' || s === 'failure') return 'failed';
  if (s === 'done' || s === 'success') return 'completed';
  return fallback;
}

function resolveStatusFilePath(projectPath, statusFilePath, profile) {
  if (statusFilePath && typeof statusFilePath === 'string') {
    const p = statusFilePath.startsWith('~')
      ? path.join(os.homedir(), statusFilePath.slice(1))
      : statusFilePath;
    return path.isAbsolute(p) ? p : path.resolve(projectPath, p);
  }

  const template = profile && profile.status && profile.status.filePathTemplate
    ? profile.status.filePathTemplate
    : '${projectPath}/.agent-status.json';

  const rendered = expandTemplate(template, { projectPath });
  if (!rendered) return '';
  return path.isAbsolute(rendered) ? rendered : path.resolve(projectPath, rendered);
}

function composeInitPrompt({ profile, request, sessionName, projectPath }) {
  const now = new Date().toISOString();
  const vars = {
    projectPath,
    sessionName,
    timestamp: now,
  };

  const requestPrompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
  const taskPrompt = typeof request.taskPrompt === 'string' ? request.taskPrompt.trim() : requestPrompt;
  const runtimeInitPrompt = typeof request.runtimeInitPrompt === 'string' ? request.runtimeInitPrompt.trim() : '';

  const profileSystem = typeof profile.systemInitPrompt === 'string' ? profile.systemInitPrompt.trim() : '';
  const systemInitPrompt = typeof request.systemInitPrompt === 'string'
    ? request.systemInitPrompt.trim()
    : profileSystem;

  const parts = [];
  if (systemInitPrompt) parts.push(expandTemplate(systemInitPrompt, vars));
  if (runtimeInitPrompt) parts.push(expandTemplate(runtimeInitPrompt, vars));
  if (taskPrompt) parts.push(taskPrompt);

  return parts.join('\n\n').trim();
}

function fallbackLabel(text) {
  if (!text) return 'task-' + Date.now().toString(36);
  const stop = new Set([
    'the','a','an','in','on','at','to','for','of','with','and','or','but','is','are','was','were',
    'be','been','have','has','had','do','does','did','will','would','could','should','can','that',
    'this','it','its','i','me','my','we','our','you','your','they','them','their','he','him','his',
    'she','her','from','by','as','all','so','if','then','than','too','very','just','about','up','out',
    'into','over','please','make'
  ]);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w && !stop.has(w));
  return words.slice(0, 4).join('-') || 'task-' + Date.now().toString(36);
}

console.log('[LABEL] Using claude CLI for smart label generation');

function callClaude(systemPrompt, userText) {
  return new Promise((resolve, reject) => {
    const prompt = `${systemPrompt}\n\n${userText}`;
    const escaped = prompt.replace(/'/g, `'\\''`);
    exec(
      `echo '${escaped}' | claude --print --model haiku 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve((stdout || '').trim());
      }
    );
  });
}

async function generateSmartLabel(text) {
  try {
    const raw = await callClaude(
      'Generate a short label (2-4 lowercase words, hyphenated, no quotes) summarizing this coding task. Reply with ONLY the label.',
      String(text || '').substring(0, 300)
    );
    const label = raw
      .toLowerCase()
      .replace(/[^a-z0-9-\s]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (label && label.length > 2 && label.length < 60) return label;
  } catch {
    // ignore
  }
  return fallbackLabel(text);
}

async function refreshDiscoveredLabel(sessionName) {
  const reg = registry[sessionName];
  if (!reg || !reg.discovered || reg.labelRefreshed) return;

  const rawOutput = capturePaneOutput(sessionName, 30);
  const output = stripAnsi(rawOutput).trim();
  if (!output || output.length < 20) return;

  reg.labelRefreshed = true;
  try {
    const label = await callClaude(
      'This is terminal output from an AI coding agent. Generate a short label (2-4 lowercase words, hyphenated, no quotes). Reply with ONLY the label.',
      output.substring(0, 500)
    );
    const clean = label
      .toLowerCase()
      .replace(/[^a-z0-9-\s]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (clean && clean.length > 2 && clean.length < 60) {
      reg.label = clean;
      saveRegistry();
    }
  } catch {
    reg.labelRefreshed = false;
  }
}

function buildProcessTree() {
  try {
    const psOutput = execSync('ps -ax -o pid= -o ppid= -o command=', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const children = {};
    const commands = {};

    for (const line of psOutput.trim().split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const [, pid, ppid, cmd] = match;
      commands[pid] = cmd.trim();
      if (!children[ppid]) children[ppid] = [];
      children[ppid].push(pid);
    }

    return { children, commands };
  } catch {
    return { children: {}, commands: {} };
  }
}

function getProcessDetectors() {
  const detectors = [];
  for (const profile of agentProfiles) {
    try {
      const re = new RegExp(profile.detect.processRegex, 'i');
      detectors.push({ agentId: profile.id, regex: re });
    } catch (e) {
      console.error(`[PROFILE] detect.processRegex 无效 (${profile.id}):`, e.message);
    }
  }
  return detectors;
}

function findAgentDescendant(pid, tree, detectors) {
  const queue = [String(pid)];
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    const cmd = tree.commands[current] || '';
    for (const detector of detectors) {
      if (detector.regex.test(cmd)) {
        return { matched: true, agentId: detector.agentId };
      }
    }

    const kids = tree.children[current] || [];
    queue.push(...kids);
  }

  return { matched: false, agentId: '' };
}

function listTmuxSessions() {
  const output = tmuxSafe(['list-sessions', '-F', '#{session_name}|#{session_activity}|#{session_created}']);
  if (!output.trim()) return [];

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [name, activity, created] = line.split('|');
      return {
        name,
        activity: Number(activity) * 1000,
        created: Number(created) * 1000,
      };
    });
}

function capturePaneOutput(sessionName, lines = 200) {
  return tmuxSafe(['capture-pane', '-e', '-t', sessionName, '-p', '-S', `-${lines}`]);
}

function getSessionPid(sessionName) {
  const output = tmuxSafe(['list-panes', '-t', sessionName, '-F', '#{pane_pid}']);
  if (!output.trim()) return null;
  const n = Number(output.trim());
  return Number.isFinite(n) ? n : null;
}

function getPaneCurrentPath(sessionName) {
  return tmuxSafe(['display-message', '-t', sessionName, '-p', '#{pane_current_path}'], 3000).trim();
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sendKey(sessionName, key) {
  tmux(['send-keys', '-t', sessionName, key], 5000);
}

async function waitForAgentReady(sessionName, profile) {
  const readiness = profile && profile.readiness ? profile.readiness : {};
  const timeoutMs = Number.isFinite(Number(readiness.timeoutMs)) ? Number(readiness.timeoutMs) : 30000;
  const pollInterval = 500;
  const maxAttempts = Math.ceil(timeoutMs / pollInterval);

  let promptRegex = null;
  if (readiness.type === 'prompt_regex' && readiness.pattern) {
    try {
      promptRegex = new RegExp(readiness.pattern, 'i');
    } catch {
      promptRegex = null;
    }
  }

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, pollInterval));

    const rawOutput = capturePaneOutput(sessionName, 30);
    const output = stripAnsi(rawOutput);
    const lines = output.split('\n').filter(l => l.trim() !== '');
    if (lines.length === 0) continue;

    const recentText = lines.slice(-8).map(l => l.trim()).join('\n');
    const lastLine = lines[lines.length - 1].trim();

    if (readiness.autoDismissClaudePrompts) {
      const isTrustPrompt = /No, exit/i.test(recentText) && /Yes, I accept/i.test(recentText);
      const isSettingsError = /Exit and fix manually/i.test(recentText) && /Continue without/i.test(recentText);
      const isInfoPrompt = /Enter to confirm/i.test(recentText)
        && !isTrustPrompt
        && !isSettingsError
        && !/space to select/i.test(recentText)
        && !/to navigate/i.test(recentText);

      if (isTrustPrompt || isSettingsError) {
        try {
          sendKey(sessionName, 'Down');
          await new Promise(r => setTimeout(r, 200));
          sendKey(sessionName, 'Enter');
        } catch {
          // ignore
        }
        continue;
      }

      if (isInfoPrompt) {
        try {
          sendKey(sessionName, 'Enter');
        } catch {
          // ignore
        }
        continue;
      }
    }

    if (promptRegex && (promptRegex.test(lastLine) || promptRegex.test(recentText))) {
      return true;
    }

    if (/esc to interrupt/i.test(recentText)) return true;
    if (/^>\s*$/.test(lastLine) || /^❯\s*$/.test(lastLine) || /^❯\s+\S/.test(lastLine)) return true;
    if (/what.*would.*like/i.test(recentText) || /can i help/i.test(recentText)) return true;
  }

  return false;
}

function mergeArgs(defaultArgs, requestArgs, argMode) {
  const base = validateArgs(defaultArgs || []);
  const incoming = validateArgs(requestArgs || []);
  if (argMode === 'replace') return incoming;
  return [...base, ...incoming];
}

async function spawnAgent(request) {
  const projectPath = normalizeProjectPath(request.projectPath);

  const profile = getAgentProfile(request.agentId) || getAgentProfile('claude');
  if (!profile) throw new Error('没有可用的 Agent Profile');

  const command = request.agentBinaryPath ? String(request.agentBinaryPath).trim() : profile.command;
  if (!command || command.length > 500 || /[\x00]/.test(command)) {
    throw new Error('agentBinaryPath 非法');
  }

  const argMode = request.argMode === 'replace' ? 'replace' : 'append';
  const launchArgs = mergeArgs(profile.defaultArgs, request.agentArgs, argMode);

  const promptSeed = String(request.prompt || request.taskPrompt || request.runtimeInitPrompt || '').trim();
  const quickLabel = fallbackLabel(promptSeed);
  const safeName = SPAWN_PREFIX + quickLabel.replace(/[^a-zA-Z0-9_-]/g, '-');

  let finalName = safeName;
  const allSessions = listTmuxSessions();
  if (allSessions.find(s => s.name === finalName) || registry[finalName]) {
    finalName = `${safeName}-${Date.now().toString(36).slice(-4)}`;
  }

  const launchCommand = buildLaunchCommand(command, launchArgs);
  tmux(['new-session', '-d', '-s', finalName, '-c', projectPath, launchCommand], 10000);

  const statusMode = STATUS_MODES.has(String(request.statusMode || ''))
    ? String(request.statusMode)
    : profile.status.mode;

  const statusFilePath = resolveStatusFilePath(projectPath, request.statusFilePath, profile);

  registry[finalName] = {
    label: quickLabel,
    projectPath,
    prompt: String(request.prompt || '').trim(),
    createdAt: Date.now(),
    state: 'running',
    initialPromptSent: false,
    discovered: false,
    agentId: profile.id,
    launchCommand,
    launchArgs,
    command,
    statusMode,
    statusSource: 'TTY',
    statusFilePath,
    callbackSecret: randomSecret(),
  };
  saveRegistry();

  const initPrompt = composeInitPrompt({
    profile,
    request,
    sessionName: finalName,
    projectPath,
  });

  generateSmartLabel(promptSeed).then(smartLabel => {
    if (smartLabel !== quickLabel && registry[finalName]) {
      registry[finalName].label = smartLabel;
      saveRegistry();
    }
  }).catch(() => {});

  if (initPrompt) {
    waitForAgentReady(finalName, profile).then(() => {
      const sent = sendToAgent(finalName, initPrompt);
      if (sent && registry[finalName]) {
        registry[finalName].initialPromptSent = true;
        registry[finalName].lastMessageSentAt = Date.now();
        saveRegistry();
      }
    });
  }

  return finalName;
}

function sendToAgent(sessionName, message) {
  if (!isSafeInputText(message)) return false;

  try {
    tmux(['send-keys', '-t', sessionName, '-l', message], 5000);
    tmux(['send-keys', '-t', sessionName, 'Enter'], 5000);
    return true;
  } catch (e) {
    console.error(`[SEND] FAILED to ${sessionName}:`, e.message);
    return false;
  }
}

function killAgent(sessionName) {
  tmuxSafe(['kill-session', '-t', sessionName], 5000);
  if (registry[sessionName]) {
    registry[sessionName].state = 'completed';
    registry[sessionName].statusSource = 'TTY';
    registry[sessionName].completedAt = Date.now();
    saveRegistry();
  }
}

function detectAgentStateHeuristic(sessionName, sessionsCache) {
  const reg = registry[sessionName];
  if (!reg) return 'unknown';

  const session = sessionsCache
    ? sessionsCache.find(s => s.name === sessionName)
    : listTmuxSessions().find(s => s.name === sessionName);

  if (!session) return 'completed';

  const pid = getSessionPid(sessionName);
  if (!isProcessAlive(pid)) return 'completed';

  if (reg.lastMessageSentAt && (Date.now() - reg.lastMessageSentAt) < 10000) {
    return 'running';
  }

  const rawOutput = capturePaneOutput(sessionName, 50);
  const output = stripAnsi(rawOutput);
  const lines = output.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return 'running';

  const recentText = lines.slice(-8).map(l => l.trim()).join('\n');
  const latestText = lines.slice(-2).map(l => l.trim()).join('\n');

  const interactivePromptPatterns = [
    /enter to select/i,
    /space to select/i,
    /to navigate.*esc to cancel/i,
    /allow\s+(once|always)/i,
    /yes.*no.*always allow/i,
    /ctrl.g to edit/i,
  ];

  if (interactivePromptPatterns.some(p => p.test(recentText))) return 'idle';
  if (/(?:esc|escape)\s+to\s+interrupt/i.test(latestText)) return 'running';

  const uiNoise = [
    /bypass permissions/i,
    /shift.?tab to cycle/i,
    /ctrl.?t to hide/i,
    /^[─━═]+$/,
  ];
  const contentLines = lines.filter(l => !uiNoise.some(p => p.test(l.trim())));
  if (contentLines.length === 0) return 'running';

  const lastLine = contentLines[contentLines.length - 1].trim();

  const idlePatterns = [
    /^>\s*$/,
    /^>\s+$/,
    /^\$\s*$/,
    /^❯\s*$/,
    /^❯\s+\S/,
    /^›\s*$/,
    /^›\s+\S/,
    /has completed/i,
    /what.*would.*like/i,
    /anything.*else/i,
    /can i help/i,
    /waiting for input/i,
  ];

  if (idlePatterns.some(p => p.test(lastLine))) return 'idle';

  const recentPromptLines = contentLines.slice(-4).map(l => l.trim());
  const promptLinePatterns = [
    /^>\s*$/,
    /^>\s+\S/,
    /^❯\s*$/,
    /^❯\s+\S/,
    /^›\s*$/,
    /^›\s+\S/,
  ];
  if (recentPromptLines.some(line => promptLinePatterns.some(p => p.test(line)))) return 'idle';

  const recentContent = contentLines.slice(-8).map(l => l.trim()).join('\n');
  const waitingForInputPatterns = [
    /do you want to proceed/i,
    /shall I proceed/i,
    /should I proceed/i,
    /approve|deny|reject/i,
    /\(y\/n\)/i,
    /enter a value|enter to confirm/i,
    /select.*option/i,
    /choose.*from/i,
    /press enter to send/i,
  ];

  if (waitingForInputPatterns.some(p => p.test(recentContent))) return 'idle';
  return 'running';
}

function parseStatusFile(reg) {
  const filePath = reg.statusFilePath;
  if (!filePath || !fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return null;

    if (raw.startsWith('{') || raw.startsWith('[')) {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const state = normalizeState(parsed.state, 'running');
      return {
        state,
        source: 'FILE',
        detail: {
          message: typeof parsed.message === 'string' ? parsed.message : '',
          progress: Number.isFinite(Number(parsed.progress)) ? Number(parsed.progress) : null,
          updatedAt: Number.isFinite(Number(parsed.updatedAt)) ? Number(parsed.updatedAt) : Date.now(),
          filePath,
        },
      };
    }

    const text = raw.toLowerCase();
    if (/failed|error/.test(text)) {
      return { state: 'failed', source: 'FILE', detail: { message: raw, filePath } };
    }
    if (/done|completed|success/.test(text)) {
      return { state: 'completed', source: 'FILE', detail: { message: raw, filePath } };
    }
    if (/idle|waiting/.test(text)) {
      return { state: 'idle', source: 'FILE', detail: { message: raw, filePath } };
    }
    if (/running|working|processing/.test(text)) {
      return { state: 'running', source: 'FILE', detail: { message: raw, filePath } };
    }
  } catch {
    return null;
  }

  return null;
}

function resolveAgentState(sessionName, sessionsCache) {
  const reg = registry[sessionName] || {};
  const statusMode = STATUS_MODES.has(reg.statusMode) ? reg.statusMode : 'heuristic';

  if ((statusMode === 'webhook' || statusMode === 'hybrid') && reg.lastHookState) {
    return {
      state: normalizeState(reg.lastHookState, 'running'),
      source: 'HOOK',
      detail: {
        message: reg.lastHookMessage || '',
        artifact: reg.lastHookArtifact || '',
        updatedAt: reg.lastHookAt || null,
      },
    };
  }

  if (statusMode === 'file_sentinel' || statusMode === 'hybrid') {
    const fileResult = parseStatusFile(reg);
    if (fileResult) return fileResult;
  }

  return {
    state: detectAgentStateHeuristic(sessionName, sessionsCache),
    source: 'TTY',
    detail: null,
  };
}

function detectPromptType(sessionName) {
  const rawOutput = capturePaneOutput(sessionName, 50);
  const output = stripAnsi(rawOutput);
  const lines = output.split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return null;

  const recentText = lines.slice(-20).map(l => l.trim()).join('\n');

  if (/space to select/i.test(recentText) && /enter to confirm/i.test(recentText)) return 'multiselect';
  if (/allow\s+(once|always)/i.test(recentText) && /deny/i.test(recentText)) return 'permission';
  if (/ctrl.g to edit/i.test(recentText)
      || (/manually approve/i.test(recentText) && /\d\.\s/.test(recentText))
      || (/execute.*plan/i.test(recentText) && /\d\.\s/.test(recentText))) {
    return 'plan';
  }
  if (/enter to select/i.test(recentText) && /to navigate/i.test(recentText)) return 'select';
  if (/\(y\/n\)/i.test(recentText) || (/yes.*no/i.test(recentText) && /do you want|shall i|should i/i.test(recentText))) {
    return 'yesno';
  }

  const numberedLines = recentText.split('\n').filter(l => /^\s*\d+[.)]\s/.test(l));
  if (numberedLines.length >= 2) return 'select';

  return null;
}

const NOISE_PATTERNS = [
  /bypass permissions/i,
  /shift.?tab to cycle/i,
  /ctrl.?t to hide/i,
  /press enter to send/i,
  /waiting for input/i,
  /^[>❯$]\s*$/,
  /^\s*$/,
];

function getLastActivity(sessionName) {
  const rawOutput = capturePaneOutput(sessionName, 30);
  const lines = rawOutput.split('\n');

  const meaningful = [];
  for (let i = lines.length - 1; i >= 0 && meaningful.length < 3; i--) {
    const clean = stripAnsi(lines[i]).trim();
    if (!clean) continue;
    if (NOISE_PATTERNS.some(p => p.test(clean))) continue;
    meaningful.unshift(lines[i]);
  }

  return meaningful.join('\n');
}

function buildAgentInfo(sessionName, sessionsCache) {
  const reg = registry[sessionName] || {};
  const stateResult = resolveAgentState(sessionName, sessionsCache);
  const state = stateResult.state;

  if (registry[sessionName]) {
    if (state === 'completed' && registry[sessionName].state !== 'completed') {
      tmuxSafe(['kill-session', '-t', sessionName], 5000);
      registry[sessionName].completedAt = registry[sessionName].completedAt || Date.now();
    }

    registry[sessionName].state = state;
    registry[sessionName].statusSource = stateResult.source;
    registry[sessionName].statusDetail = stateResult.detail;

    if (state === 'idle' && !registry[sessionName].idleSince) {
      registry[sessionName].idleSince = Date.now();
    } else if (state !== 'idle') {
      delete registry[sessionName].idleSince;
      if (state !== 'running') {
        delete registry[sessionName].lastMessageSentAt;
      }
    }
  }

  const promptType = (state === 'completed' || state === 'failed') ? null : detectPromptType(sessionName);

  return {
    name: sessionName,
    label: reg.label || sessionName,
    projectPath: reg.projectPath || '',
    prompt: reg.prompt || '',
    state,
    promptType,
    createdAt: reg.createdAt || 0,
    idleSince: reg.idleSince || null,
    completedAt: reg.completedAt || null,
    lastActivity: (state === 'completed' || state === 'failed') ? '' : getLastActivity(sessionName),
    discovered: Boolean(reg.discovered),
    agentId: reg.agentId || '',
    statusMode: reg.statusMode || 'heuristic',
    statusSource: stateResult.source,
    statusDetail: stateResult.detail,
    statusFilePath: reg.statusFilePath || '',
  };
}

function buildRegistryFromDiscoveredSession(session, agentId) {
  const profile = getAgentProfile(agentId) || getAgentProfile('claude') || agentProfiles[0];
  const projectPath = getPaneCurrentPath(session.name);

  registry[session.name] = {
    label: session.name,
    projectPath,
    prompt: '',
    createdAt: session.created,
    state: 'running',
    discovered: true,
    agentId: profile ? profile.id : '',
    statusMode: profile ? profile.status.mode : 'heuristic',
    statusSource: 'TTY',
    statusFilePath: resolveStatusFilePath(projectPath || '.', '', profile || {}),
    callbackSecret: randomSecret(),
  };
}

function getAllAgents() {
  const sessions = listTmuxSessions();
  const processTree = buildProcessTree();
  const detectors = getProcessDetectors();

  for (const session of sessions) {
    if (registry[session.name]) continue;

    const cached = nonAgentCache.get(session.name);
    if (cached && Date.now() - cached < 30000) continue;

    const panePid = getSessionPid(session.name);
    if (!panePid) continue;

    const detection = findAgentDescendant(panePid, processTree, detectors);
    if (detection.matched) {
      buildRegistryFromDiscoveredSession(session, detection.agentId);
      refreshDiscoveredLabel(session.name);
    } else {
      nonAgentCache.set(session.name, Date.now());
    }
  }

  const liveNames = new Set(sessions.map(s => s.name));
  for (const name of Object.keys(registry)) {
    if (!liveNames.has(name) && !['completed', 'failed'].includes(registry[name].state)) {
      registry[name].state = 'completed';
      registry[name].statusSource = 'TTY';
      registry[name].completedAt = registry[name].completedAt || Date.now();
    }
  }

  for (const name of Object.keys(registry)) {
    const r = registry[name];
    if (r.discovered && r.label === name && !r.labelRefreshed && !['completed', 'failed'].includes(r.state)) {
      refreshDiscoveredLabel(name);
    }
  }

  const agents = Object.keys(registry).map(name => buildAgentInfo(name, sessions));
  saveRegistry();
  return agents;
}

function sanitizeProfileForClient(profile) {
  return {
    id: profile.id,
    displayName: profile.displayName,
    command: profile.command,
    defaultArgs: profile.defaultArgs,
    readiness: profile.readiness,
    status: profile.status,
    systemInitPrompt: profile.systemInitPrompt,
  };
}

function getRegistryLaunchSpec(reg) {
  if (reg && reg.launchCommand) {
    return reg.launchCommand;
  }
  const profile = getAgentProfile(reg && reg.agentId) || getAgentProfile('claude') || agentProfiles[0];
  return buildLaunchCommand(profile.command, profile.defaultArgs || []);
}

const UPLOAD_DIR = path.join(os.tmpdir(), 'agent-viewer-uploads');

app.get('/api/agent-profiles', (req, res) => {
  try {
    res.json(agentProfiles.map(sanitizeProfileForClient));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/recent-projects', (req, res) => {
  try {
    const seen = new Map();
    for (const agent of Object.values(registry)) {
      if (!agent.projectPath) continue;
      const existing = seen.get(agent.projectPath) || 0;
      const ts = agent.createdAt || 0;
      if (ts > existing) seen.set(agent.projectPath, ts);
    }

    const sorted = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p);

    res.json(sorted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agents', (req, res) => {
  try {
    res.json(getAllAgents());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents', async (req, res) => {
  try {
    const { projectPath } = req.body || {};
    const prompt = String((req.body && (req.body.prompt || req.body.taskPrompt)) || '').trim();

    if (!projectPath || !prompt) {
      return res.status(400).json({ error: 'projectPath 和 prompt/taskPrompt 为必填' });
    }

    const name = await spawnAgent(req.body);
    const reg = registry[name];

    res.json({
      name,
      status: 'spawned',
      agentId: reg && reg.agentId,
      callbackSecret: reg && reg.callbackSecret,
      statusMode: reg && reg.statusMode,
      statusFilePath: reg && reg.statusFilePath,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/status-callback', (req, res) => {
  try {
    const { name } = req.params;
    const reg = registry[name];
    if (!reg) return res.status(404).json({ error: 'Agent not found' });

    const secret = req.headers['x-agent-callback-secret'] || req.body.signature || req.query.signature || '';
    if (reg.callbackSecret && secret !== reg.callbackSecret) {
      return res.status(403).json({ error: 'invalid callback secret' });
    }

    const nextState = normalizeState(req.body.state, reg.state || 'running');
    reg.lastHookState = nextState;
    reg.lastHookAt = Number.isFinite(Number(req.body.updatedAt)) ? Number(req.body.updatedAt) : Date.now();
    reg.lastHookMessage = typeof req.body.message === 'string' ? req.body.message : '';
    reg.lastHookArtifact = typeof req.body.artifact === 'string' ? req.body.artifact : '';
    reg.statusSource = 'HOOK';
    reg.statusMode = STATUS_MODES.has(reg.statusMode) ? reg.statusMode : 'webhook';

    if (nextState === 'completed' || nextState === 'failed') {
      reg.completedAt = reg.completedAt || Date.now();
    }

    saveRegistry();
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/send', (req, res) => {
  try {
    const { name } = req.params;
    const { message } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    if (!isSafeInputText(message)) {
      return res.status(400).json({ error: 'message 非法或过长' });
    }

    const reg = registry[name];

    if (reg && (reg.state === 'completed' || reg.state === 'failed')) {
      const projectPath = reg.projectPath || '.';
      const launchCommand = getRegistryLaunchSpec(reg);

      tmux(['new-session', '-d', '-s', name, '-c', projectPath, launchCommand], 10000);

      reg.state = 'running';
      reg.statusSource = 'TTY';
      reg.prompt = message;
      delete reg.idleSince;
      delete reg.completedAt;
      delete reg.lastHookState;
      delete reg.lastHookAt;
      saveRegistry();

      const profile = getAgentProfile(reg.agentId) || getAgentProfile('claude') || agentProfiles[0];
      waitForAgentReady(name, profile).then(() => {
        sendToAgent(name, message);
      });

      return res.json({ status: 'respawned' });
    }

    const success = sendToAgent(name, message);
    if (!success) {
      return res.status(500).json({ error: 'Failed to send message' });
    }

    if (reg) {
      reg.state = 'running';
      reg.statusSource = 'TTY';
      reg.lastMessageSentAt = Date.now();
      delete reg.idleSince;
      saveRegistry();
    }

    res.json({ status: 'sent' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/upload', (req, res) => {
  try {
    const { name } = req.params;

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          return res.status(400).json({ error: 'Invalid multipart form' });
        }

        const boundary = boundaryMatch[1];
        const bodyStr = buf.toString('latin1');
        const filenameMatch = bodyStr.match(/filename="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : `upload-${Date.now()}`;

        const headerEnd = bodyStr.indexOf('\r\n\r\n');
        const fileStart = headerEnd + 4;
        const fileEnd = bodyStr.lastIndexOf(`\r\n--${boundary}`);
        const fileBytes = buf.slice(
          Buffer.byteLength(bodyStr.substring(0, fileStart), 'latin1'),
          Buffer.byteLength(bodyStr.substring(0, fileEnd), 'latin1')
        );

        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const savePath = path.join(UPLOAD_DIR, `${Date.now()}-${filename}`);
        fs.writeFileSync(savePath, fileBytes);

        const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(filename);
        const msg = isImage
          ? `Look at this image and tell me what you see: ${savePath}`
          : `Read this file: ${savePath}`;

        sendToAgent(name, msg);

        if (registry[name]) {
          registry[name].state = 'running';
          registry[name].statusSource = 'TTY';
          delete registry[name].idleSince;
          saveRegistry();
        }

        res.json({ status: 'uploaded', path: savePath });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/agents/:name', (req, res) => {
  try {
    killAgent(req.params.name);
    res.json({ status: 'killed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/agents/:name/cleanup', (req, res) => {
  try {
    const { name } = req.params;
    if (!registry[name]) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!['completed', 'failed'].includes(registry[name].state)) {
      return res.status(400).json({ error: 'Agent is not completed/failed' });
    }
    delete registry[name];
    saveRegistry();
    res.json({ status: 'cleaned' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/cleanup/completed', (req, res) => {
  try {
    let count = 0;
    for (const name of Object.keys(registry)) {
      if (['completed', 'failed'].includes(registry[name].state)) {
        delete registry[name];
        count++;
      }
    }
    saveRegistry();
    res.json({ status: 'cleaned', count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/keys', (req, res) => {
  try {
    const { name } = req.params;
    const { keys } = req.body || {};
    if (!keys) {
      return res.status(400).json({ error: 'keys is required' });
    }

    const allowed = ['Up', 'Down', 'Space', 'Enter', 'Escape', 'Tab'];
    if (!allowed.includes(keys)) {
      return res.status(400).json({ error: `Invalid key. Allowed: ${allowed.join(', ')}` });
    }

    sendKey(name, keys);

    if (registry[name]) {
      registry[name].lastMessageSentAt = Date.now();
      saveRegistry();
    }

    res.json({ status: 'sent', key: keys });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/plan-feedback', async (req, res) => {
  try {
    const { name } = req.params;
    const { message } = req.body || {};
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const rawOutput = capturePaneOutput(name, 50);
    const output = stripAnsi(rawOutput);
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
    const recentLines = lines.slice(-20);

    const optionLines = recentLines.filter(l => /^\d+[.)]\s/.test(l));
    const typeHereIdx = optionLines.findIndex(l => /type here/i.test(l));

    if (typeHereIdx < 0) {
      return res.status(400).json({ error: 'Could not find "Type here" option in plan prompt' });
    }

    for (let i = 0; i < optionLines.length + 2; i++) {
      sendKey(name, 'Up');
      await new Promise(r => setTimeout(r, 50));
    }

    for (let i = 0; i < typeHereIdx; i++) {
      sendKey(name, 'Down');
      await new Promise(r => setTimeout(r, 50));
    }

    sendKey(name, 'Enter');
    await new Promise(r => setTimeout(r, 500));

    tmux(['send-keys', '-t', name, '-l', message], 5000);
    sendKey(name, 'Enter');

    if (registry[name]) {
      registry[name].lastMessageSentAt = Date.now();
      saveRegistry();
    }

    res.json({ status: 'sent', optionIndex: typeHereIdx });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/agents/:name/output', (req, res) => {
  try {
    const raw = capturePaneOutput(req.params.name, 200);
    const clean = stripAnsi(raw);
    res.json({ output: clean, raw });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/browse', (req, res) => {
  try {
    const dir = req.query.dir || os.homedir();
    const resolved = path.resolve(String(dir));

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: 'Not a valid directory' });
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    res.json({
      current: resolved,
      parent: path.dirname(resolved),
      dirs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const sseClients = new Set();

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

function broadcastAgents() {
  if (sseClients.size === 0) return;

  try {
    const agents = getAllAgents();
    const data = JSON.stringify({ type: 'agents', agents });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  } catch (e) {
    console.error('SSE broadcast error:', e.message);
  }
}

function runHealthChecks() {
  try {
    tmux(['-V'], 3000);
  } catch {
    console.warn('[HEALTH] 未检测到 tmux，相关功能将不可用。');
  }

  for (const profile of agentProfiles) {
    const cmd = profile.command;
    if (!cmd || cmd.includes('/')) continue;
    try {
      execFileSync('which', [cmd], { encoding: 'utf-8', timeout: 3000, stdio: 'ignore' });
    } catch {
      console.warn(`[HEALTH] 命令未找到: ${cmd} (profile=${profile.id})`);
    }
  }
}

loadRegistry();
loadAgentProfiles();
runHealthChecks();

app.listen(PORT, HOST === 'localhost' ? '127.0.0.1' : HOST, () => {
  console.log('\n  AGENT VIEWER');
  console.log('  ════════════════════════════════');
  console.log(`  Local:   http://localhost:${PORT}`);

  if (HOST === '0.0.0.0') {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
      for (const addr of iface || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          console.log(`  Network: http://${addr.address}:${PORT}`);
        }
      }
    }
  }

  console.log('  ════════════════════════════════\n');
});

setInterval(broadcastAgents, POLL_INTERVAL);
