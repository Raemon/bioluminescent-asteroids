import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_PORT = 5173;
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];

const isHostPortInUse = (port, host) =>
  new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(300);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (err) => {
      resolve(err.code !== "ECONNREFUSED");
    });
  });

const isPortInUse = async (port) => {
  for (const host of LOOPBACK_HOSTS) {
    if (await isHostPortInUse(port, host)) return true;
  }
  return false;
};

const findAvailablePort = async (startPort) => {
  for (let port = startPort; port < startPort + 20; port++) {
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + 19}`);
};

const port = await findAvailablePort(DEFAULT_PORT);
if (port !== DEFAULT_PORT) {
  console.log(`Port ${DEFAULT_PORT} is in use, using ${port} instead.`);
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const viteBin = join(projectRoot, "node_modules", ".bin", "vite");
const vite = spawn(viteBin, ["--port", String(port), "--strictPort"], {
  stdio: "inherit",
  cwd: projectRoot,
});
vite.on("exit", (code) => process.exit(code ?? 0));
