/* Runs before the real server starts. Kills anything already using the
   port, so npm start always works even after a leftover process. */

const { execSync } = require('child_process');

const PORT = process.env.PORT || 3000;

function freePort(port) {
  try {
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
      const pids = new Set();
      output.split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      });
      pids.forEach((pid) => {
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
          console.log(`Freed port ${port} (stopped leftover process ${pid}).`);
        } catch (killErr) {
          console.log(`Could not stop process ${pid} — it may already be gone.`);
        }
      });
    } else {
      const output = execSync(`lsof -ti tcp:${port}`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
      if (output) {
        output.split('\n').forEach((pid) => {
          try {
            execSync(`kill -9 ${pid}`, { stdio: 'ignore' });
            console.log(`Freed port ${port} (stopped leftover process ${pid}).`);
          } catch (killErr) {
            console.log(`Could not stop process ${pid} — it may already be gone.`);
          }
        });
      }
    }
  } catch (findErr) {
    console.log(`Port ${port} is already free.`);
  }
}

freePort(PORT);
require('./index.js');
