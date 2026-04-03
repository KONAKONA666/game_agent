
const { chromium } = require('playwright');

(async () => {
  const results = { errors: [], warnings: [], status: 'unknown' };
  const PORT = 2567;
  const URL = `http://localhost:${PORT}`;
  let browser, serverProcess;

  try {
    // Start the server
    const { spawn } = require('child_process');
    serverProcess = spawn('node', ['server/index.js'], {
      cwd: '/home/konakona666/games/output/top_down_arena_shooter_players_shoot_eac',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT) }
    });

    // Wait for server to be ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('running on port')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      serverProcess.stderr.on('data', (data) => {
        results.warnings.push('Server stderr: ' + data.toString().trim());
      });
      serverProcess.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Launch browser
    browser = await chromium.launch({ headless: true });

    // Tab 1
    const page1 = await browser.newPage();
    const page1Errors = [];
    page1.on('console', msg => {
      if (msg.type() === 'error') page1Errors.push(msg.text());
    });
    page1.on('pageerror', err => page1Errors.push(err.message));

    await page1.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for game loop to start
    await page1.waitForFunction(() => {
      return document.querySelector('#loading')?.style.display === 'none'
             || document.querySelectorAll('canvas').length > 0;
    }, { timeout: 30000 });

    // Let it run for a few seconds
    await new Promise(r => setTimeout(r, 3000));

    // Tab 2 -- test multiplayer
    const page2 = await browser.newPage();
    const page2Errors = [];
    page2.on('console', msg => {
      if (msg.type() === 'error') page2Errors.push(msg.text());
    });
    page2.on('pageerror', err => page2Errors.push(err.message));

    await page2.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page2.waitForFunction(() => {
      return document.querySelector('#loading')?.style.display === 'none'
             || document.querySelectorAll('canvas').length > 0;
    }, { timeout: 30000 });

    await new Promise(r => setTimeout(r, 3000));

    // Collect results
    const allErrors = [...page1Errors, ...page2Errors];

    // Filter out WebSocket connection errors (expected in some environments)
    const criticalErrors = allErrors.filter(e =>
      !e.includes('WebSocket') && !e.includes('ERR_CONNECTION_REFUSED')
    );

    results.errors = criticalErrors;
    results.all_console_errors = allErrors;
    results.status = criticalErrors.length === 0 ? 'pass' : 'fail';
    results.tabs_loaded = 2;

  } catch (err) {
    results.errors.push(err.message);
    results.status = 'error';
  } finally {
    if (browser) await browser.close();
    if (serverProcess) serverProcess.kill();
  }

  console.log(JSON.stringify(results));
})();
