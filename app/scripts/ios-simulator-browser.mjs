#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export function parseArgs(argv) {
  const options = {
    doctor: false,
    dryRun: false,
    noMetro: false,
    projectRoot: path.resolve(path.dirname(scriptPath), '..'),
    simulator: undefined,
    skipPrebuild: false,
    skipRun: false,
    serveOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--doctor') options.doctor = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-metro') options.noMetro = true;
    else if (arg === '--skip-prebuild') options.skipPrebuild = true;
    else if (arg === '--skip-run') options.skipRun = true;
    else if (arg === '--serve-only') {
      options.serveOnly = true;
      options.skipPrebuild = true;
      options.skipRun = true;
    } else if (arg === '--sim' || arg === '--simulator') {
      index += 1;
      options.simulator = argv[index];
    } else if (arg === '--project-root') {
      index += 1;
      options.projectRoot = path.resolve(argv[index]);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.simulator === '') throw new Error('--sim requires a simulator UDID or name');
  return options;
}

export function parseAvailableSimulators(simctlJson) {
  const parsed = JSON.parse(simctlJson);
  const devices = parsed.devices && typeof parsed.devices === 'object' ? parsed.devices : {};
  return Object.entries(devices)
    .flatMap(([runtime, runtimeDevices]) =>
      Array.isArray(runtimeDevices)
        ? runtimeDevices.map((device) => ({
            name: String(device.name ?? ''),
            runtime,
            state: String(device.state ?? ''),
            udid: String(device.udid ?? ''),
            isAvailable: device.isAvailable !== false && device.availabilityError == null,
          }))
        : [],
    )
    .filter((device) => device.udid && device.name && device.isAvailable);
}

export function selectSimulator(devices, requested) {
  if (requested) {
    return (
      devices.find((device) => device.udid === requested) ??
      devices.find((device) => device.name.toLowerCase() === requested.toLowerCase()) ??
      null
    );
  }

  return (
    devices.find((device) => device.state === 'Booted' && /iphone/i.test(device.name)) ??
    devices.find((device) => /iphone/i.test(device.name)) ??
    devices[0] ??
    null
  );
}

export function hasNativeIosProject(projectRoot) {
  const iosRoot = path.join(projectRoot, 'ios');
  if (!existsSync(iosRoot)) return false;
  return readdirSync(iosRoot, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace')),
  );
}

export function createPlan({ projectRoot, simulator, nativeProjectExists, noMetro, skipPrebuild, skipRun, serveOnly }) {
  const steps = [];
  if (!serveOnly && !skipPrebuild && !nativeProjectExists) {
    steps.push({
      label: 'Generate iOS native project',
      command: 'npx',
      args: ['expo', 'prebuild', '--platform', 'ios'],
      cwd: projectRoot,
    });
  }
  if (!serveOnly && !skipRun && !noMetro) {
    steps.push({
      label: 'Start Metro bundler',
      command: 'npx',
      args: ['expo', 'start', '--localhost', '--port', '8081'],
      cwd: projectRoot,
      background: true,
    });
  }
  if (!serveOnly && !skipRun) {
    steps.push({
      label: 'Build and launch app on iOS Simulator',
      command: 'npx',
      args: ['expo', 'run:ios', '--no-bundler', '--device', simulator.udid],
      cwd: projectRoot,
    });
  }
  steps.push({
    label: 'Clear stale scoped simulator mirror',
    command: 'npx',
    args: ['--yes', 'serve-sim@latest', '--kill', simulator.udid],
    cwd: projectRoot,
    optional: true,
  });
  steps.push({
    label: 'Mirror Simulator into Codex in-app browser',
    command: 'npx',
    args: ['--yes', 'serve-sim@latest', simulator.udid],
    cwd: projectRoot,
    longRunning: true,
  });
  return steps;
}

export function formatStep(step) {
  const args = step.args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
  return `${step.command} ${args}`;
}

function printHelp() {
  console.log(`OpenCode Mobile iOS Simulator browser helper

Usage:
  npm run ios:sim:doctor
  npm run ios:sim:browser -- --sim <simulator-udid-or-name>
  npm run ios:sim:browser -- --serve-only --sim <booted-simulator-udid>

This must run on macOS with Xcode command line tools. It builds the native iOS
app, starts a simulator-scoped serve-sim mirror, and prints the browser URL that
must be opened in the Codex in-app browser for screenshot proof.`);
}

function requireMacToolchain() {
  if (process.platform !== 'darwin') {
    throw new Error(`iOS Simulator requires macOS with Xcode. This host is ${process.platform}; xcrun is unavailable here.`);
  }
  for (const command of ['xcrun', 'xcodebuild', 'npx']) {
    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
    if (result.error) throw new Error(`Missing required command: ${command}`);
  }
}

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep(step, backgroundChildren) {
  console.log(`\n==> ${step.label}`);
  console.log(`$ ${formatStep(step)}`);
  if (step.optional) {
    spawnSync(step.command, step.args, { cwd: step.cwd, stdio: 'ignore' });
    return 0;
  }
  if (step.background) {
    const child = spawn(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' });
    backgroundChildren.push(child);
    await delay(5_000);
    if (child.exitCode != null) return child.exitCode;
    return 0;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd: step.cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  requireMacToolchain();
  const simctlJson = runCapture('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], options.projectRoot);
  const simulators = parseAvailableSimulators(simctlJson);
  const simulator = selectSimulator(simulators, options.simulator);
  if (!simulator) {
    throw new Error(options.simulator ? `Simulator not found: ${options.simulator}` : 'No available iOS Simulator found');
  }

  const nativeProjectExists = hasNativeIosProject(options.projectRoot);
  const plan = createPlan({
    projectRoot: options.projectRoot,
    simulator,
    nativeProjectExists,
    noMetro: options.noMetro,
    skipPrebuild: options.skipPrebuild,
    skipRun: options.skipRun,
    serveOnly: options.serveOnly,
  });

  console.log(`Project: ${options.projectRoot}`);
  console.log(`Simulator: ${simulator.name} (${simulator.udid}) ${simulator.state}`);
  console.log(`Native iOS project: ${nativeProjectExists ? 'present' : 'missing; prebuild required'}`);
  for (const step of plan) console.log(`- ${step.label}: ${formatStep(step)}`);

  if (options.doctor || options.dryRun) return;

  const backgroundChildren = [];
  let cleanupNeeded = false;
  const cleanup = () => {
    for (const child of backgroundChildren.splice(0)) {
      if (child.exitCode == null) child.kill('SIGTERM');
    }
    if (!cleanupNeeded) return;
    cleanupNeeded = false;
    spawnSync('npx', ['--yes', 'serve-sim@latest', '--kill', simulator.udid], { cwd: options.projectRoot, stdio: 'ignore' });
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('SIGHUP', () => {
    cleanup();
    process.exit(129);
  });
  process.on('uncaughtException', (error) => {
    cleanup();
    throw error;
  });
  process.on('unhandledRejection', (reason) => {
    cleanup();
    throw reason instanceof Error ? reason : new Error(String(reason));
  });

  try {
    for (const step of plan) {
      if (step.longRunning) cleanupNeeded = true;
      const code = await runStep(step, backgroundChildren);
      if (code !== 0) throw new Error(`${step.label} failed with exit code ${code}`);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  cleanup();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
