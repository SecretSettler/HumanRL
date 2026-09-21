use flate2::read::GzDecoder;
use serde::Serialize;
use std::{
    fs::{self, File},
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StackStatus {
    url: String,
    project: String,
}

fn docker_binary() -> Result<PathBuf, String> {
    let candidates = [
        "/usr/local/bin/docker",
        "/opt/homebrew/bin/docker",
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
        .or_else(|| {
            Command::new("docker")
                .arg("version")
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|_| PathBuf::from("docker"))
        })
        .ok_or_else(|| "未找到 Docker CLI；请先安装并启动 Docker Desktop".to_string())
}

fn checked(mut command: Command, description: &str) -> Result<String, String> {
    let output = command
        .output()
        .map_err(|error| format!("{description}: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("{description}: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn extract_stack(archive_path: &Path, target: &Path) -> Result<(), String> {
    let marker = target.join(".intenttrace-stack-v2");
    if marker.is_file() {
        return Ok(());
    }
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| format!("清理旧服务失败: {error}"))?;
    }
    fs::create_dir_all(target).map_err(|error| format!("创建服务目录失败: {error}"))?;
    let file =
        File::open(archive_path).map_err(|error| format!("读取内置服务归档失败: {error}"))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));
    for entry in archive
        .entries()
        .map_err(|error| format!("解析服务归档失败: {error}"))?
    {
        let mut entry = entry.map_err(|error| format!("读取归档条目失败: {error}"))?;
        if !entry
            .unpack_in(target)
            .map_err(|error| format!("释放服务归档失败: {error}"))?
        {
            return Err("拒绝越界的服务归档路径".to_string());
        }
    }
    File::create(marker).map_err(|error| format!("写入服务版本标记失败: {error}"))?;
    Ok(())
}

fn start_stack_blocking(app: tauri::AppHandle) -> Result<StackStatus, String> {
    let docker = docker_binary()?;
    let mut info = Command::new(&docker);
    info.arg("info");
    checked(info, "Docker Desktop 尚未就绪")?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    let stack_dir = data_dir.join("stack-v2");
    extract_stack(
        &resource_dir.join("resources/intenttrace-stack.tar.gz"),
        &stack_dir,
    )?;
    let compose = stack_dir.join("docker-compose.yml");
    let common = ["compose", "-p", "intenttrace-desktop", "-f"];
    let mut up = Command::new(&docker);
    up.args(common)
        .arg(&compose)
        .args(["up", "-d", "--build", "--wait"]);
    checked(up, "启动 IntentTrace Docker 栈失败")?;
    let mut port = Command::new(&docker);
    port.args(common)
        .arg(&compose)
        .args(["port", "web", "3000"]);
    let mapping = checked(port, "查询动态 loopback 端口失败")?;
    let port_number = mapping
        .rsplit(':')
        .next()
        .filter(|value| value.chars().all(|character| character.is_ascii_digit()))
        .ok_or_else(|| format!("无法解析 Web 端口: {mapping}"))?;
    Ok(StackStatus {
        url: format!("http://127.0.0.1:{port_number}"),
        project: "intenttrace-desktop".to_string(),
    })
}

#[tauri::command]
async fn start_stack(app: tauri::AppHandle) -> Result<StackStatus, String> {
    tauri::async_runtime::spawn_blocking(move || start_stack_blocking(app))
        .await
        .map_err(|error| format!("服务启动任务失败: {error}"))?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start_stack])
        .run(tauri::generate_context!())
        .expect("IntentTrace desktop runtime failed");
}
