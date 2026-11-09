#!/usr/bin/env bun
/**
 * Sub-Store 单二进制启动包装器
 *
 * 打包方式：bun build --compile --asset-naming=[name].[ext]
 * 将前端 dist/ 以资产形式嵌入，运行时解压到临时目录，
 * 再通过环境变量告知后端前端路径。
 */

import { join } from "path";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { parseArgs } from "util";

// ── 解析命令行参数 ──────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "api-port":      { type: "string", default: "3000" },
    "frontend-port": { type: "string", default: "3001" },
    "api-host":      { type: "string", default: "0.0.0.0" },
    "data-path":     { type: "string", default: join(process.env.HOME ?? ".", "sub-store-data") },
    "backend-path":  { type: "string", default: "/" },
    help:            { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`
Sub-Store - All-in-one binary

Usage:
  sub-store [options]

Options:
  --api-port      <port>   Backend API port       (default: 3000)
  --frontend-port <port>   Frontend HTTP port     (default: 3001)
  --api-host      <host>   Backend API host       (default: 0.0.0.0)
  --data-path     <path>   Data storage directory (default: ~/sub-store-data)
  --backend-path  <path>   Backend URL path       (default: /)
  --help                   Show this help

Access:
  Frontend: http://localhost:<frontend-port>
  API:      http://localhost:<api-port>
`);
  process.exit(0);
}

// ── 解压嵌入的前端资产到临时目录 ────────────────────────────────────────────
// bun --compile 支持通过 Bun.file(import.meta.dir + "/...") 访问嵌入资产
// 但由于 dist/ 文件较多，我们在 workflow 中用 zip 打包为单个资产，运行时解压

const frontendZip = Bun.file(import.meta.dir + "/frontend-dist.zip");
const tmpFrontendDir = join(tmpdir(), `sub-store-frontend-${Date.now()}`);

async function extractFrontend() {
  if (!await frontendZip.exists()) {
    console.error("[sub-store] ERROR: Embedded frontend asset not found.");
    process.exit(1);
  }

  mkdirSync(tmpFrontendDir, { recursive: true });

  // 写出 zip 文件，用系统 unzip 解压
  const zipPath = join(tmpdir(), "sub-store-frontend.zip");
  writeFileSync(zipPath, Buffer.from(await frontendZip.arrayBuffer()));

  const unzip = Bun.spawn(["unzip", "-o", "-q", zipPath, "-d", tmpFrontendDir]);
  const exitCode = await unzip.exited;
  if (exitCode !== 0) {
    console.error("[sub-store] ERROR: Failed to extract frontend assets.");
    process.exit(1);
  }

  console.log(`[sub-store] Frontend extracted to: ${tmpFrontendDir}`);
  return tmpFrontendDir;
}

// ── 启动后端 ────────────────────────────────────────────────────────────────
async function startBackend(frontendPath: string) {
  const backendFile = Bun.file(import.meta.dir + "/sub-store.bundle.js");
  if (!await backendFile.exists()) {
    console.error("[sub-store] ERROR: Embedded backend not found.");
    process.exit(1);
  }

  // 写出后端脚本到临时目录（Node 需要从文件系统读取）
  const bundlePath = join(tmpdir(), "sub-store.bundle.js");
  writeFileSync(bundlePath, Buffer.from(await backendFile.arrayBuffer()));

  const env = {
    ...process.env,
    SUB_STORE_BACKEND_API_PORT:    args["api-port"]!,
    SUB_STORE_BACKEND_API_HOST:    args["api-host"]!,
    SUB_STORE_FRONTEND_PATH:       frontendPath,
    SUB_STORE_FRONTEND_PORT:       args["frontend-port"]!,
    SUB_STORE_DATA_BASE_PATH:      args["data-path"]!,
    SUB_STORE_FRONTEND_BACKEND_PATH: args["backend-path"]!,
  };

  // 确保数据目录存在
  mkdirSync(args["data-path"]!, { recursive: true });

  console.log(`[sub-store] Starting backend  on port ${args["api-port"]}`);
  console.log(`[sub-store] Serving frontend  on port ${args["frontend-port"]}`);
  console.log(`[sub-store] Data directory:   ${args["data-path"]}`);

  // 用 bun 运行后端脚本（sub-store.bundle.js 兼容 Node/Bun）
  const proc = Bun.spawn(["bun", "run", bundlePath], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  });

  // 转发信号
  process.on("SIGINT",  () => { proc.kill("SIGINT");  });
  process.on("SIGTERM", () => { proc.kill("SIGTERM"); });

  await proc.exited;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
const frontendPath = await extractFrontend();
await startBackend(frontendPath);
