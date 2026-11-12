import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const target = "x86_64-pc-windows-msvc";
const output = path.join(root, "target", "update-windows-x64");
const keyPath = process.env.DBX_SIGNING_KEY_PATH || path.join(homedir(), ".dbx-signing", "AnonPai-dbx.key");

async function main() {
  if (process.platform !== "win32") throw new Error("请在 Windows 上执行打包。");
  if (!existsSync(keyPath) || !existsSync(`${keyPath}.pub`)) {
    throw new Error(`缺少签名密钥，请恢复 ${keyPath} 及对应的 .pub 文件。`);
  }
  if (readFileSync(`${keyPath}.pub`, "utf8").trim() !== config.plugins.updater.pubkey) {
    throw new Error("签名公钥与客户端配置不一致，请使用原来的密钥。");
  }
  const version = config.version;
  const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8"))?.[1];
  if (version !== packageVersion || version !== cargoVersion) throw new Error("三个应用版本号必须一致。");
  mkdirSync(output, { recursive: true });
  const logPath = path.join(root, "target", "package-windows.log");
  // 清单在完整打包成功后才发布，失败重试时避免残留上一轮的清单。
  rmSync(path.join(output, "latest.json"), { force: true });
  const log = openSync(logPath, "w");
  console.log(`正在打包 Windows x64 ${version}，详细输出写入 ${logPath}`);
  const env = {
    ...process.env,
    PATH: [path.join(homedir(), ".cargo", "bin"), "C:\\Strawberry\\perl\\bin", process.env.PATH || ""].join(";"),
    TAURI_SIGNING_PRIVATE_KEY: keyPath,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || "",
    CARGO_TARGET_DIR: path.join(root, "target"),
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
        "build", "--ci", "--target", target, "--bundles", "nsis",
        "--features", "sqlite-bundled,os-keyring", "--", "--no-default-features",
      ], { cwd: root, env, stdio: ["ignore", log, log], windowsHide: true });
      const stop = () => child.kill();
      process.once("SIGINT", stop);
      child.once("error", reject);
      child.once("exit", (code) => {
        process.removeListener("SIGINT", stop);
        if (code === 0) resolve();
        else reject(new Error(`打包失败，退出码 ${code}，查看 ${logPath}`));
      });
    });
  } finally {
    closeSync(log);
  }
  const installer = path.join(root, "target", target, "release", "bundle", "nsis", `DBX_${version}_x64-setup.exe`);
  const signature = readFileSync(`${installer}.sig`, "utf8").trim();
  if (!signature) throw new Error("安装包签名为空。");
  copyFileSync(installer, path.join(output, "DBX-setup.exe"));
  const manifest = {
    version,
    notes: process.env.DBX_RELEASE_NOTES || "MySQL / PostgreSQL / ClickHouse / Redis Windows x64 build",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        url: `https://raw.githubusercontent.com/AnonPai/dbx/main/DBX-setup.exe?v=${encodeURIComponent(version)}`,
        signature,
      },
    },
  };
  writeFileSync(path.join(output, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(path.join(output, "DBX-setup.exe"), path.join(root, "DBX-setup.exe"));
  copyFileSync(path.join(output, "latest.json"), path.join(root, "latest.json"));
  console.log(`打包完成，DBX-setup.exe 和 latest.json 已复制到 ${root}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
